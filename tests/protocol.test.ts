import assert from 'node:assert/strict';
import test from 'node:test';
import { message, parseEnvelope } from '../packages/protocol/src/index.js';
import { buildTvStickCommand, SerialOperationError, TvStickTestBoxAdapter } from '../apps/client/src/serial.js';

test('creates and parses a versioned message envelope', () => {
  const envelope = message('client.heartbeat', { health: 'healthy' }, 'client-001');
  const parsed = parseEnvelope(JSON.stringify(envelope));
  assert.equal(parsed.id, envelope.id);
  assert.equal(parsed.version, '1.0');
  assert.equal(parsed.type, 'client.heartbeat');
  assert.equal(parsed.clientId, 'client-001');
});

test('rejects malformed message envelopes', () => {
  assert.throws(() => parseEnvelope(JSON.stringify({ type: 'client.heartbeat' })), /invalid message envelope/);
});

test('maps supported TV Stick operations to fixed AT commands', () => {
  assert.deepEqual(buildTvStickCommand('hdmi.switch', { output: 'TVB' }), { command: 'AT+HDMI1=TVB' });
  assert.deepEqual(buildTvStickCommand('usb.status', {}), { command: 'AT+USBPATH?', responsePrefix: 'USBPATH:' });
  assert.deepEqual(buildTvStickCommand('system.reset', { mode: 'DFU' }), { command: 'AT+SYSRST=DFU' });
});

test('rejects unsafe TV Stick command parameters', () => {
  assert.throws(() => buildTvStickCommand('hdmi.switch', { output: 'RAW' }), (error: unknown) => error instanceof SerialOperationError && error.code === 'INVALID_ARGUMENT');
  assert.throws(() => buildTvStickCommand('unknown.operation', {}), (error: unknown) => error instanceof SerialOperationError && error.code === 'UNSUPPORTED_OPERATION');
});

test('executes an adapter operation through a fake serial session', async () => {
  const calls: string[] = [];
  const adapter = new TvStickTestBoxAdapter(100, async () => ({
    execute: async (command: string) => {
      calls.push(command);
      return 'HDMI1:ON,TVB';
    },
    close: async () => undefined,
  }));
  const result = await adapter.execute({
    commandId: 'cmd-test',
    deviceId: 'serial:test',
    operation: 'hdmi.status',
    parameters: {},
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  }, {
    deviceId: 'serial:test',
    path: '/dev/ttyUSB0',
    stableIdentity: true,
    status: 'available',
    observedAt: new Date().toISOString(),
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['AT+HDMI1?']);
});
