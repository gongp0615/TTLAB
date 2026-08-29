import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceCommandExecutor } from '../apps/client/src/executor.js';
import type { CommandRequest, SerialDevice } from '../packages/protocol/src/index.js';
import type { SerialAdapter } from '../apps/client/src/serial.js';

const device = (deviceId: string): SerialDevice => ({ deviceId, path: `/dev/${deviceId}`, stableIdentity: true, status: 'available', observedAt: new Date().toISOString() });
const request = (commandId: string, deviceId: string): CommandRequest => ({ commandId, deviceId, operation: 'system.ping', parameters: {}, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString() });

test('serial commands for the same device are mutually exclusive and release the lock', async () => {
  const executor = new DeviceCommandExecutor();
  let release!: () => void;
  const firstStarted = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const adapter: SerialAdapter = {
    execute: async (command) => {
      calls += 1;
      await firstStarted;
      return { commandId: command.commandId, deviceId: command.deviceId, success: true, output: 'OK' };
    },
  };
  const first = executor.execute(request('cmd-1', 'serial-1'), device('serial-1'), adapter);
  while (calls !== 1) await new Promise((resolve) => setImmediate(resolve));
  const second = await executor.execute(request('cmd-2', 'serial-1'), device('serial-1'), adapter);
  assert.equal(second.success, false);
  assert.equal(second.error?.code, 'SERIAL_BUSY');
  release();
  assert.equal((await first).success, true);
  assert.equal(executor.activeCommandIds.length, 0);
  assert.equal((await executor.execute(request('cmd-3', 'serial-1'), device('serial-1'), { execute: async (command) => ({ commandId: command.commandId, deviceId: command.deviceId, success: true }) })).success, true);
});

test('different devices can execute concurrently', async () => {
  const executor = new DeviceCommandExecutor();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter: SerialAdapter = { execute: async (command) => { await gate; return { commandId: command.commandId, deviceId: command.deviceId, success: true }; } };
  const first = executor.execute(request('cmd-1', 'serial-1'), device('serial-1'), adapter);
  const second = executor.execute(request('cmd-2', 'serial-2'), device('serial-2'), adapter);
  assert.deepEqual(executor.activeCommandIds.sort(), ['cmd-1', 'cmd-2']);
  release();
  assert.equal((await Promise.all([first, second])).every((result) => result.success), true);
});
