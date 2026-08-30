import assert from 'node:assert/strict';
import test from 'node:test';
import { message, parseCommandProgress, parseCommandRequest, parseClientHello, parseDeviceLogChunk, parseEnvelope, validateCommandParameters, type DeviceOperation } from '../packages/protocol/src/index.js';
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

test('system.log is a Server to Web envelope and is rejected on the client session', () => {
  const entry = { ts: new Date().toISOString(), type: 'event', clientId: 'client-001', data: { action: 'client.connected' } };
  const envelope = message('system.log', entry, 'client-001');
  assert.equal(envelope.type, 'system.log');
  assert.equal(envelope.payload, entry);
  // system.log 仅用于 Server→Web 实时事件；Client 会话协议不接收该类型
  assert.throws(() => parseEnvelope(JSON.stringify(envelope)), /invalid message envelope/);
});

test('parses client hello with hostname and addresses', () => {
  const hello = parseClientHello({ clientVersion: '1.0.0', protocolVersion: '1.0', bootId: 'boot-test', platform: 'linux', architecture: 'arm64', capabilities: ['serial'], hostname: 'device-01', addresses: ['192.168.1.5', 'fe80::1'] });
  assert.equal(hello.hostname, 'device-01');
  assert.deepEqual(hello.addresses, ['192.168.1.5', 'fe80::1']);
});

test('parses client hello without optional hostname and addresses', () => {
  const hello = parseClientHello({ clientVersion: '1.0.0', protocolVersion: '1.0', bootId: 'boot-test', platform: 'linux', architecture: 'arm64', capabilities: ['serial'] });
  assert.equal(hello.hostname, undefined);
  assert.equal(hello.addresses, undefined);
});

test('validates bounded device log chunks', () => {
  const chunk = parseDeviceLogChunk({ deviceId: 'tvbox:test', portId: 'log', sequence: 1, capturedAt: new Date().toISOString(), data: 'boot ok\n', encoding: 'utf-8', truncated: false });
  assert.equal(chunk.sequence, 1);
  assert.throws(() => parseDeviceLogChunk({ ...chunk, sequence: -1 }), /invalid device log chunk/);
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

test('builds TV Stick commands from the operation catalog with template substitution', () => {
  assert.deepEqual(buildTvStickCommand('hdmi.switch', { output: 'ON' }), { command: 'AT+HDMI1=ON' });
  assert.deepEqual(buildTvStickCommand('usb.path', { path: 'HST2DUT' }), { command: 'AT+USBPATH=HST2DUT' });
  assert.deepEqual(buildTvStickCommand('hardware.rgb', { value: '255' }), { command: 'AT+RGB=255' });
  assert.deepEqual(buildTvStickCommand('system.ping', {}), { command: 'AT+PING?', responsePrefix: 'PING:' });
});

test('validateCommandParameters rejects unknown operations', () => {
  assert.equal(validateCommandParameters(undefined, {}), 'operation is not supported');
});

test('validateCommandParameters enforces enum parameter values', () => {
  const operation: DeviceOperation = { operation: 'hdmi.switch', command: 'AT+HDMI1={output}', parameters: [{ name: 'output', type: 'enum', options: ['TVA', 'TVB', 'ON', 'OFF'], required: true }] };
  assert.equal(validateCommandParameters(operation, { output: 'TVA' }), undefined);
  assert.match(validateCommandParameters(operation, { output: 'RAW' }) ?? '', /must be one of TVA, TVB, ON, OFF/);
  assert.match(validateCommandParameters(operation, {}) ?? '', /is required/);
});

test('validateCommandParameters enforces string pattern parameters', () => {
  const operation: DeviceOperation = { operation: 'hardware.rgb', command: 'AT+RGB={value}', parameters: [{ name: 'value', type: 'string', pattern: '^\\d{3}$', required: true }] };
  assert.equal(validateCommandParameters(operation, { value: '255' }), undefined);
  assert.match(validateCommandParameters(operation, { value: '12' }) ?? '', /invalid format/);
  assert.match(validateCommandParameters(operation, { value: '' }) ?? '', /is required/);
});

test('validateCommandParameters passes operations without parameters', () => {
  const operation: DeviceOperation = { operation: 'system.ping', command: 'AT+PING?', parameters: [] };
  assert.equal(validateCommandParameters(operation, {}), undefined);
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

test('parses a command request with a firmware download reference', () => {
  const request = parseCommandRequest({
    commandId: 'cmd-1',
    deviceId: 'tvbox:test',
    operation: 'firmware.flash',
    parameters: { version: 'V39', artifact: 'Panda_COM-V39-release.bin' },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    firmware: { release: 'V39', artifact: 'Panda_COM-V39-release.bin', downloadUrl: 'http://server/agent/v1/releases/V39/Panda_COM-V39-release.bin?clientId=client-1', sha256: 'a'.repeat(64), expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(request.operation, 'firmware.flash');
  assert.equal(request.firmware?.release, 'V39');
  assert.equal(request.firmware?.sha256, 'a'.repeat(64));
});

test('parses a command request without a firmware reference', () => {
  const request = parseCommandRequest({ commandId: 'cmd-1', deviceId: 'tvbox:test', operation: 'system.ping', parameters: {}, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() });
  assert.equal(request.firmware, undefined);
});

test('rejects a command request with an invalid firmware sha256', () => {
  assert.throws(() => parseCommandRequest({
    commandId: 'cmd-1',
    deviceId: 'tvbox:test',
    operation: 'firmware.flash',
    parameters: {},
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    firmware: { release: 'V39', artifact: 'panda.bin', downloadUrl: 'http://server/agent/v1/releases/V39/panda.bin', sha256: 'not-a-hash', expiresAt: new Date().toISOString() },
  }), /sha256/);
});

test('rejects a command request with an unsafe firmware artifact name', () => {
  assert.throws(() => parseCommandRequest({
    commandId: 'cmd-1',
    deviceId: 'tvbox:test',
    operation: 'firmware.flash',
    parameters: {},
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    firmware: { release: 'V39', artifact: '../evil.bin', downloadUrl: 'http://server/agent/v1/releases/V39/evil.bin', sha256: 'a'.repeat(64), expiresAt: new Date().toISOString() },
  }), /safe path segments/);
});

test('parses and validates command progress messages', () => {
  const progress = parseCommandProgress({ commandId: 'cmd-1', deviceId: 'tvbox:test', stage: 'flashing', progress: 42, message: 'writing flash' });
  assert.equal(progress.stage, 'flashing');
  assert.equal(progress.progress, 42);
  assert.equal(progress.message, 'writing flash');
  assert.throws(() => parseCommandProgress({ commandId: 'cmd-1', deviceId: 'tvbox:test', stage: 'unknown', progress: 42 }), /invalid/);
  assert.throws(() => parseCommandProgress({ commandId: 'cmd-1', deviceId: 'tvbox:test', stage: 'flashing', progress: 101 }), /between 0 and 100/);
});
