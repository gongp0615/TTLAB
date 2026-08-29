import { createReadStream, constants as fsConstants, type ReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { validateCommandParameters, type CommandRequest, type CommandResult, type SerialDevice } from '../../../packages/protocol/src/index.js';
import { tvBoxProfile } from './discovery.js';

const maxOutputLength = 16 * 1024;
const serialPollIntervalMs = 20;

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

export async function probeTvStickPort(path: string, timeoutMs = 3000, sessionFactory: AtSessionFactory | undefined = undefined, command = 'AT+PING?', responsePrefix = 'PING:'): Promise<boolean> {
  const session = await (sessionFactory ?? ((serialPath, timeout) => SerialSession.open(serialPath, timeout)))(path, timeoutMs);
  try {
    await session.execute(command, responsePrefix);
    return true;
  } catch {
    return false;
  } finally {
    await session.close();
  }
}

export class SerialLogCollector {
  private constructor(private readonly reader: ReadStream, private readonly onData: (data: string) => void, private readonly onError: (error: Error) => void) {}

  static async open(path: string, onData: (data: string) => void, onError: (error: Error) => void, baudRate?: string): Promise<SerialLogCollector> {
    await configureSerialPort(path, baudRate);
    const reader = createReadStream(path, { encoding: 'utf8' });
    const collector = new SerialLogCollector(reader, onData, onError);
    reader.on('data', (chunk) => collector.onData(String(chunk)));
    reader.on('error', (error) => collector.onError(error));
    return collector;
  }

  async close(): Promise<void> {
    if (this.reader.destroyed) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      this.reader.once('close', () => { clearTimeout(timeout); resolve(); });
      this.reader.destroy();
    });
  }
}

export function buildTvStickCommand(operation: string, parameters: Record<string, string>): { command: string; responsePrefix?: string } {
  const entry = tvBoxProfile?.operations?.find((item) => item.operation === operation);
  if (!entry) throw new SerialOperationError('UNSUPPORTED_OPERATION', `unsupported TV Stick operation: ${operation}`, false);
  const validationError = validateCommandParameters(entry, parameters);
  if (validationError) throw new SerialOperationError('INVALID_ARGUMENT', validationError, false);
  const command = entry.command.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => parameters[name] ?? '');
  return entry.responsePrefix ? { command, responsePrefix: entry.responsePrefix } : { command };
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
  private constructor(private readonly handle: FileHandle, private readonly timeoutMs: number) {}

  static async open(path: string, timeoutMs: number): Promise<SerialSession> {
    await configureSerialPort(path);
    // The port must be opened non-blocking: a blocking read would make close()
    // hang forever because a pending read on a character device cannot be
    // interrupted, which left commands stuck in the "accepted" state.
    const handle = await open(path, fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
    return new SerialSession(handle, timeoutMs);
  }

  async execute(command: string, responsePrefix?: string): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    await this.writeCommand(command, deadline);
    return this.readResponse(responsePrefix, deadline);
  }

  private async writeCommand(command: string, deadline: number): Promise<void> {
    const payload = Buffer.from(`${command}\r\n`, 'utf8');
    let offset = 0;
    while (offset < payload.length) {
      if (Date.now() >= deadline) {
        throw new SerialOperationError('SERIAL_TIMEOUT', `serial response timed out after ${this.timeoutMs}ms`, true);
      }
      try {
        const { bytesWritten } = await this.handle.write(payload, offset, payload.length - offset, null);
        offset += bytesWritten;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
          await new Promise((resolve) => setTimeout(resolve, serialPollIntervalMs));
          continue;
        }
        throw new SerialOperationError('SERIAL_WRITE_FAILED', error instanceof Error ? error.message : 'serial write failed', true);
      }
    }
  }

  private async readResponse(responsePrefix: string | undefined, deadline: number): Promise<string> {
    const buffer = Buffer.alloc(4096);
    let output = '';
    while (Date.now() < deadline) {
      let bytesRead = 0;
      try {
        bytesRead = (await this.handle.read(buffer, 0, buffer.length, null)).bytesRead;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
          await new Promise((resolve) => setTimeout(resolve, serialPollIntervalMs));
          continue;
        }
        throw new SerialOperationError('SERIAL_READ_FAILED', error instanceof Error ? error.message : 'serial read failed', true);
      }
      if (bytesRead > 0) {
        output = `${output}${buffer.subarray(0, bytesRead).toString('utf8')}`.slice(-maxOutputLength);
        const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.some((line) => line === 'ERROR' || line.startsWith('ERROR'))) {
          throw new SerialOperationError('DEVICE_ERROR', lines.find((line) => line.startsWith('ERROR')) ?? 'device returned ERROR', false);
        }
        if (lines.includes('OK') || (responsePrefix && lines.some((line) => line.startsWith(responsePrefix)))) {
          return output.trim();
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, serialPollIntervalMs));
      }
    }
    throw new SerialOperationError('SERIAL_TIMEOUT', `serial response timed out after ${this.timeoutMs}ms`, true);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export async function configureSerialPort(path: string, baudRate = process.env.TTLAB_SERIAL_BAUD ?? '115200'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('stty', ['-F', path, baudRate, 'cs8', '-cstopb', '-parenb', '-ixon', '-ixoff', 'raw', '-echo']);
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new SerialOperationError('SERIAL_CONFIG_FAILED', error.trim() || `stty exited with code ${code}`, true)));
  });
}
