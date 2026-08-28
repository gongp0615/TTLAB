import { createReadStream, type ReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { CommandRequest, CommandResult, SerialDevice } from '../../../packages/protocol/src/index.js';

const maxOutputLength = 16 * 1024;

export class SerialOperationError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) {
    super(message);
  }
}

export interface SerialAdapter {
  execute(request: CommandRequest, device: SerialDevice): Promise<CommandResult>;
}

export interface AtSession {
  execute(command: string, responsePrefix?: string): Promise<string>;
  close(): Promise<void>;
}

export type AtSessionFactory = (path: string, timeoutMs: number) => Promise<AtSession>;

export function buildTvStickCommand(operation: string, parameters: Record<string, string>): { command: string; responsePrefix?: string } {
  switch (operation) {
    case 'hdmi.switch': {
      const output = parameters.output;
      if (!output || !['TVA', 'TVB', 'ON', 'OFF'].includes(output)) throw new SerialOperationError('INVALID_ARGUMENT', 'output must be TVA, TVB, ON or OFF', false);
      return { command: `AT+HDMI1=${output}` };
    }
    case 'hdmi.status': return { command: 'AT+HDMI1?', responsePrefix: 'HDMI1:' };
    case 'usb.path': {
      const path = parameters.path;
      if (!path || !['HST2DUT', 'HST2DSK', 'DUT2DSK', 'HST#DUT', 'ON', 'OFF'].includes(path)) throw new SerialOperationError('INVALID_ARGUMENT', 'unsupported USB path', false);
      return { command: `AT+USBPATH=${path}` };
    }
    case 'usb.status': return { command: 'AT+USBPATH?', responsePrefix: 'USBPATH:' };
    case 'system.ping': return { command: 'AT+PING?', responsePrefix: 'PING:' };
    case 'system.version': return { command: 'AT+VER?', responsePrefix: 'VER:' };
    case 'system.reset': {
      const mode = parameters.mode;
      if (!mode || !['REBOOT', 'DFU'].includes(mode)) throw new SerialOperationError('INVALID_ARGUMENT', 'mode must be REBOOT or DFU', false);
      return { command: `AT+SYSRST=${mode}` };
    }
    case 'device.reboot': {
      const mode = parameters.mode;
      if (!mode || !['NRM', 'DWN'].includes(mode)) throw new SerialOperationError('INVALID_ARGUMENT', 'mode must be NRM or DWN', false);
      return { command: `AT+REBOOT=${mode}` };
    }
    case 'hardware.rgb': {
      const value = parameters.value;
      if (!value || !/^\d{3}$/.test(value)) throw new SerialOperationError('INVALID_ARGUMENT', 'RGB value must contain three digits', false);
      return { command: `AT+RGB=${value}` };
    }
    case 'hardware.lcd': {
      const mode = parameters.mode;
      if (!mode || !['LCDOFF', 'LCDLOGO'].includes(mode)) throw new SerialOperationError('INVALID_ARGUMENT', 'unsupported LCD mode', false);
      return { command: `AT+SYSCMD=${mode}` };
    }
    default: throw new SerialOperationError('UNSUPPORTED_OPERATION', `unsupported TV Stick operation: ${operation}`, false);
  }
}

export class TvStickTestBoxAdapter implements SerialAdapter {
  constructor(private readonly timeoutMs = 3000, private readonly sessionFactory: AtSessionFactory = (path, timeout) => SerialSession.open(path, timeout)) {}

  async execute(request: CommandRequest, device: SerialDevice): Promise<CommandResult> {
    const mapped = buildTvStickCommand(request.operation, request.parameters);
    const session = await this.sessionFactory(device.path, this.timeoutMs);
    try {
      const output = await session.execute(mapped.command, mapped.responsePrefix);
      return { commandId: request.commandId, deviceId: request.deviceId, success: true, output: output.slice(-maxOutputLength) };
    } catch (error) {
      const operationError = error instanceof SerialOperationError ? error : new SerialOperationError('SERIAL_ERROR', error instanceof Error ? error.message : 'serial operation failed', true);
      return { commandId: request.commandId, deviceId: request.deviceId, success: false, error: { code: operationError.code, message: operationError.message, retryable: operationError.retryable } };
    } finally {
      await session.close();
    }
  }
}

class SerialSession implements AtSession {
  private constructor(private readonly writer: FileHandle, private readonly reader: ReadStream, private readonly timeoutMs: number) {}

  static async open(path: string, timeoutMs: number): Promise<SerialSession> {
    await configureSerial(path);
    const writer = await open(path, 'r+');
    const reader = createReadStream(path, { encoding: 'utf8' });
    return new SerialSession(writer, reader, timeoutMs);
  }

  async execute(command: string, responsePrefix?: string): Promise<string> {
    const reader = this.reader as ReadStream & { on(event: 'data', listener: (chunk: string) => void): void; removeListener(event: 'data', listener: (chunk: string) => void): void };
    return new Promise<string>((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reader.removeListener('data', onData);
        if (error) reject(error); else resolve(output.trim());
      };
      const onData = (chunk: string): void => {
        output = `${output}${chunk}`.slice(-maxOutputLength);
        const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.some((line) => line === 'ERROR' || line.startsWith('ERROR'))) {
          finish(new SerialOperationError('DEVICE_ERROR', lines.find((line) => line.startsWith('ERROR')) ?? 'device returned ERROR', false));
        } else if (lines.includes('OK') || (responsePrefix && lines.some((line) => line.startsWith(responsePrefix)))) {
          finish();
        }
      };
      const timer = setTimeout(() => finish(new SerialOperationError('SERIAL_TIMEOUT', `serial response timed out after ${this.timeoutMs}ms`, true)), this.timeoutMs);
      reader.on('data', onData);
      this.writer.write(`${command}\r\n`).catch((error) => finish(new SerialOperationError('SERIAL_WRITE_FAILED', error instanceof Error ? error.message : 'serial write failed', true)));
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.reader.once('close', resolve);
      this.reader.destroy();
    });
    await this.writer.close();
  }
}

async function configureSerial(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('stty', ['-F', path, process.env.TTLAB_SERIAL_BAUD ?? '115200', 'cs8', '-cstopb', '-parenb', '-ixon', '-ixoff', 'raw', '-echo']);
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new SerialOperationError('SERIAL_CONFIG_FAILED', error.trim() || `stty exited with code ${code}`, true)));
  });
}
