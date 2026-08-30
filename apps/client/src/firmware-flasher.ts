import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { CommandRequest, CommandResult, CommandProgress, ManagedDevice, SerialDevice } from '../../../packages/protocol/src/index.js';
import { SerialOperationError, type SerialAdapter } from './serial.js';
import type { DeviceManager } from './device-manager.js';

export type FlashStage = CommandProgress['stage'];

export interface FlashContext {
  request: CommandRequest;
  device: ManagedDevice;
  port: SerialDevice;
  adapter: SerialAdapter;
  deviceManager: DeviceManager;
  reportProgress(stage: FlashStage, progress: number, message?: string): void;
}

export interface FirmwareFlasher {
  flash(context: FlashContext): Promise<CommandResult>;
}

export interface DfuUtilOptions {
  dfuUtilPath?: string;
  dfuVid?: string;
  dfuPid?: string;
  downloadTimeoutMs?: number;
  dfuWaitTimeoutMs?: number;
  flashTimeoutMs?: number;
  verifyTimeoutMs?: number;
  restartTimeoutMs?: number;
  readbackVerify?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class UsbDfuFlasher implements FirmwareFlasher {
  private readonly dfuUtilPath: string;
  private readonly dfuVid: string;
  private readonly dfuPid: string;
  private readonly downloadTimeoutMs: number;
  private readonly dfuWaitTimeoutMs: number;
  private readonly flashTimeoutMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly restartTimeoutMs: number;
  private readonly readbackVerify: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly options: { stateDirectory: string; token?: string } & DfuUtilOptions) {
    this.dfuUtilPath = options.dfuUtilPath ?? 'dfu-util';
    this.dfuVid = options.dfuVid ?? '28e9';
    this.dfuPid = options.dfuPid ?? '018a';
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000;
    this.dfuWaitTimeoutMs = options.dfuWaitTimeoutMs ?? 60_000;
    this.flashTimeoutMs = options.flashTimeoutMs ?? 180_000;
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? 60_000;
    this.restartTimeoutMs = options.restartTimeoutMs ?? 60_000;
    this.readbackVerify = options.readbackVerify ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async flash(context: FlashContext): Promise<CommandResult> {
    const request = context.request;
    const firmware = request.firmware;
    if (!firmware) return this.failure(request, 'INVALID_ARGUMENT', 'firmware download reference is missing', false);
    const downloadPath = join(this.options.stateDirectory, 'firmware-flash');
    const binaryPath = join(downloadPath, `${request.commandId}.bin`);
    mkdirSync(downloadPath, { recursive: true, mode: 0o750 });
    try {
      // 1. download and verify the firmware artifact
      context.reportProgress('downloading', 5, `downloading ${firmware.artifact}`);
      if (!await this.download(firmware.downloadUrl, firmware.sha256, binaryPath)) {
        return this.failure(request, 'FLASH_DOWNLOAD_FAILED', 'firmware download failed or sha256 mismatch', true);
      }
      context.reportProgress('downloading', 20, 'firmware verified');

      // 2. record the old firmware version
      context.reportProgress('verifying', 25, 'reading current firmware version');
      const oldVersion = await this.readVersion(context);

      // 3. enter DFU mode
      context.reportProgress('entering-dfu', 30, 'rebooting to DFU mode');
      const enterResult = await this.executeAtCommand(context, 'system.reset', { mode: 'DFU' });
      if (!enterResult.success) return this.failure(request, 'FLASH_DFU_ENTER_FAILED', 'failed to enter DFU mode', true);

      // 4. wait for the USB DFU device to appear
      context.reportProgress('waiting-for-dfu', 35, 'waiting for USB DFU device');
      if (!await this.waitForDfuDevice()) {
        return this.failure(request, 'FLASH_DFU_WAIT_TIMEOUT', 'DFU device did not appear within the timeout', true);
      }

      // 5. flash with one idempotent retry on failure
      context.reportProgress('flashing', 40, 'starting DFU flash');
      let flashOk = await this.runDfuFlash(binaryPath, (progress) => context.reportProgress('flashing', 40 + progress * 0.4, 'flashing firmware'));
      if (!flashOk) {
        context.reportProgress('flashing', 40, 'retrying DFU flash');
        flashOk = await this.runDfuFlash(binaryPath, (progress) => context.reportProgress('flashing', 40 + progress * 0.4, 'retrying firmware flash'));
      }
      if (!flashOk) return this.failure(request, 'FLASH_FAILED_DEVICE_IN_DFU', 'DFU flash failed; the device may be stuck in DFU mode', true);

      // 6. optional readback verification
      if (this.readbackVerify) {
        context.reportProgress('verifying-flash', 85, 'verifying flashed firmware');
        const verifyPath = join(downloadPath, `${request.commandId}.verify.bin`);
        if (!await this.verifyDfu(binaryPath, verifyPath)) {
          return this.failure(request, 'FLASH_VERIFY_FAILED', 'firmware readback did not match', true);
        }
      }

      // 7. wait for the device to restart and the control port to return
      context.reportProgress('restarting', 92, 'waiting for device restart');
      if (!await this.waitForDeviceBack(context)) {
        return this.failure(request, 'FLASH_RESTART_TIMEOUT', 'device did not return after flashing', true);
      }

      // 8. read the new version and compare
      context.reportProgress('verifying-firmware', 96, 'reading new firmware version');
      const newVersion = await this.readVersion(context);
      const output = `flashed ${firmware.release} (${firmware.artifact})\nold version: ${oldVersion}\nnew version: ${newVersion}`;
      return { commandId: request.commandId, deviceId: request.deviceId, success: true, output };
    } catch (error) {
      const operationError = error instanceof SerialOperationError ? error : new SerialOperationError('FLASH_FAILED', error instanceof Error ? error.message : 'firmware flash failed', true);
      return this.failure(request, operationError.code, operationError.message, operationError.retryable);
    }
  }

  private async download(url: string, expectedSha256: string, path: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...(this.options.token ? { headers: { authorization: `Bearer ${this.options.token}` } } : {}),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return false;
      const hash = createHash('sha256');
      const writer = createWriteStream(path, { flags: 'w', mode: 0o600 });
      for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!writer.write(buffer)) {
          await new Promise<void>((resolve) => writer.once('drain', resolve));
        }
        hash.update(buffer);
      }
      writer.end();
      await finished(writer);
      return hash.digest('hex').toLowerCase() === expectedSha256.toLowerCase();
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readVersion(context: FlashContext): Promise<string> {
    const result = await this.executeAtCommand(context, 'system.version', {});
    return result.success ? (result.output?.trim() ?? 'unknown') : 'unknown';
  }

  private async executeAtCommand(context: FlashContext, operation: string, parameters: Record<string, string>): Promise<CommandResult> {
    const request = context.request;
    const command: CommandRequest = {
      commandId: request.commandId,
      deviceId: request.deviceId,
      operation,
      parameters,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    return context.adapter.execute(command, context.port);
  }

  private async waitForDfuDevice(): Promise<boolean> {
    const deadline = Date.now() + this.dfuWaitTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.dfuDevicePresent()) return true;
      await this.sleepImpl(500);
    }
    return false;
  }

  private async dfuDevicePresent(): Promise<boolean> {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(this.dfuUtilPath, ['-l']);
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('dfu-util -l timed out')); }, 5_000);
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(`${stdout}\n${stderr}`);
          else resolve(`${stdout}\n${stderr}`);
        });
      });
      const needle = `[${this.dfuVid.toLowerCase()}:${this.dfuPid.toLowerCase()}]`;
      return output.toLowerCase().includes(needle);
    } catch {
      return false;
    }
  }

  private async runDfuFlash(binaryPath: string, onProgress: (progress: number) => void): Promise<boolean> {
    try {
      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn(this.dfuUtilPath, ['-d', `${this.dfuVid}:${this.dfuPid}`, '-D', binaryPath]);
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, this.flashTimeoutMs);
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          const match = stderr.match(/(\d{1,3})%/g);
          if (match && match.length > 0) {
            const last = Number(match[match.length - 1]?.replace('%', ''));
            if (Number.isFinite(last)) onProgress(Math.min(100, last) / 100);
          }
        });
        child.once('error', () => { clearTimeout(timer); resolve(1); });
        child.once('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  private async verifyDfu(binaryPath: string, verifyPath: string): Promise<boolean> {
    try {
      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn(this.dfuUtilPath, ['-d', `${this.dfuVid}:${this.dfuPid}`, '-U', verifyPath]);
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, this.verifyTimeoutMs);
        child.once('error', () => { clearTimeout(timer); resolve(1); });
        child.once('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
      });
      if (exitCode !== 0) return false;
      const { readFileSync } = await import('node:fs');
      const binaryHash = createHash('sha256').update(readFileSync(binaryPath)).digest('hex').toLowerCase();
      const readHash = createHash('sha256').update(readFileSync(verifyPath)).digest('hex').toLowerCase();
      return readHash === binaryHash;
    } catch {
      return false;
    }
  }

  private async waitForDeviceBack(context: FlashContext): Promise<boolean> {
    const deadline = Date.now() + this.restartTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await context.deviceManager.refresh();
        const target = context.deviceManager.resolveCommandTarget(context.request.deviceId);
        if (target) return true;
      } catch {
        // device is still coming back; keep polling
      }
      await this.sleepImpl(500);
    }
    return false;
  }

  private failure(request: CommandRequest, code: string, message: string, retryable: boolean): CommandResult {
    return { commandId: request.commandId, deviceId: request.deviceId, success: false, error: { code, message, retryable } };
  }
}
