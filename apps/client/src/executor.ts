import type { CommandRequest, CommandResult, SerialDevice } from '../../../packages/protocol/src/index.js';
import { SerialOperationError, type SerialAdapter } from './serial.js';

export class DeviceCommandExecutor {
  private readonly activeDevices = new Map<string, string>();

  get activeCommandIds(): string[] {
    return [...this.activeDevices.values()];
  }

  isBusy(deviceId: string): boolean {
    return this.activeDevices.has(deviceId);
  }

  async execute(request: CommandRequest, device: SerialDevice, adapter: SerialAdapter): Promise<CommandResult> {
    if (this.activeDevices.has(device.deviceId)) {
      return {
        commandId: request.commandId,
        deviceId: request.deviceId,
        success: false,
        error: { code: 'SERIAL_BUSY', message: 'another serial command is running for this device', retryable: true },
      };
    }
    this.activeDevices.set(device.deviceId, request.commandId);
    try {
      return await adapter.execute(request, device);
    } catch (error) {
      const operationError = error instanceof SerialOperationError ? error : new SerialOperationError('SERIAL_ERROR', error instanceof Error ? error.message : 'serial command failed', true);
      return { commandId: request.commandId, deviceId: request.deviceId, success: false, error: { code: operationError.code, message: operationError.message, retryable: operationError.retryable } };
    } finally {
      this.activeDevices.delete(device.deviceId);
    }
  }

  acquire(deviceId: string, commandId: string): boolean {
    if (this.activeDevices.has(deviceId)) return false;
    this.activeDevices.set(deviceId, commandId);
    return true;
  }

  release(deviceId: string): void {
    this.activeDevices.delete(deviceId);
  }
}
