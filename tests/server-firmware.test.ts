import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { message, parseEnvelope, type ClientSnapshot, type DeviceOperation, type ManagedDevice } from '../packages/protocol/src/index.js';
import { FirmwareStore, FirmwareStoreError } from '../apps/server/src/firmware.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitForOutput(child: ChildProcessWithoutNullStreams, match: (line: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 5_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      if (lines.some(match)) { clearTimeout(timeout); child.stdout.off('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited with ${code}`)); });
  });
}

function waitForMessage(socket: WebSocket, predicate: (value: ReturnType<typeof parseEnvelope>) => boolean): Promise<ReturnType<typeof parseEnvelope>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket message timeout')), 5_000);
    const onMessage = (data: WebSocket.RawData) => {
      const value = parseEnvelope(data.toString());
      if (predicate(value)) { clearTimeout(timeout); socket.off('message', onMessage); resolve(value); }
    };
    socket.on('message', onMessage);
  });
}

async function* bodySource(content: Buffer | string): AsyncGenerator<Buffer> {
  yield Buffer.isBuffer(content) ? content : Buffer.from(content);
}

test('FirmwareStore publishes, reads and lists firmware releases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-fw-unit-'));
  try {
    const store = new FirmwareStore({ directory: root });
    const payload = Buffer.from('GD32 firmware payload');
    const manifest = await store.publish({ version: 'V39', artifact: 'Panda_COM-V39-release.bin', deviceTypes: ['tv-stick-test-box'], description: 'release', body: bodySource(payload) });
    assert.equal(manifest.version, 'V39');
    assert.equal(manifest.artifact, 'Panda_COM-V39-release.bin');
    assert.equal(manifest.size, payload.length);
    assert.equal(manifest.sha256.length, 64);
    assert.deepEqual(manifest.deviceTypes, ['tv-stick-test-box']);

    const read = store.read('V39');
    assert.equal(read?.sha256, manifest.sha256);
    assert.deepEqual(read?.deviceTypes, ['tv-stick-test-box']);
    assert.equal(readFileSync(store.artifactPath('V39', 'Panda_COM-V39-release.bin') as string, 'utf8'), payload.toString('utf8'));
    assert.deepEqual(store.list().map((item) => item.version), ['V39']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('FirmwareStore supports multiple device types per release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-fw-unit-'));
  try {
    const store = new FirmwareStore({ directory: root });
    const manifest = await store.publish({ version: 'V40', artifact: 'multi.bin', deviceTypes: ['tv-stick-test-box', 'another-box'], body: bodySource('x') });
    assert.deepEqual(manifest.deviceTypes, ['tv-stick-test-box', 'another-box']);
    assert.deepEqual(store.read('V40')?.deviceTypes, ['tv-stick-test-box', 'another-box']);
    // 重复项会被去重
    const dedup = await store.publish({ version: 'V41', artifact: 'dedup.bin', deviceTypes: ['a', 'a', 'b'], body: bodySource('y') });
    assert.deepEqual(dedup.deviceTypes, ['a', 'b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('FirmwareStore normalizes legacy single deviceType manifests on read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-fw-unit-'));
  try {
    const store = new FirmwareStore({ directory: root });
    const legacy: Record<string, unknown> = { version: 'LEGACY', artifact: 'legacy.bin', sha256: 'a'.repeat(64), size: 4, deviceType: 'tv-stick-test-box', releasedAt: new Date().toISOString() };
    mkdirSync(join(root, 'firmware', 'LEGACY'), { recursive: true });
    writeFileSync(join(root, 'firmware', 'LEGACY', 'manifest.json'), JSON.stringify(legacy));
    const manifest = store.read('LEGACY');
    assert.equal(manifest?.version, 'LEGACY');
    assert.deepEqual(manifest?.deviceTypes, ['tv-stick-test-box']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('FirmwareStore rejects unsafe versions, oversized payloads and duplicate publishes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-fw-unit-'));
  try {
    const store = new FirmwareStore({ directory: root, maxBytes: 8 });
    await assert.rejects(() => store.publish({ version: '../evil', artifact: 'a.bin', body: bodySource('x') }), (error: unknown) => error instanceof FirmwareStoreError && error.code === 'INVALID_ARGUMENT');
    await assert.rejects(() => store.publish({ version: 'V1', artifact: 'a.bin', body: bodySource('too-large-payload') }), (error: unknown) => error instanceof FirmwareStoreError && error.code === 'PAYLOAD_TOO_LARGE');
    await store.publish({ version: 'V1', artifact: 'a.bin', body: bodySource('ok') });
    await assert.rejects(() => store.publish({ version: 'V1', artifact: 'b.bin', body: bodySource('ok') }), (error: unknown) => error instanceof FirmwareStoreError && error.code === 'ALREADY_EXISTS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Server firmware upload, list, download and flash dispatch work end to end', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-fw-srv-'));
  const logDir = join(root, 'logs');
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], { cwd: process.cwd(), env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_HEARTBEAT_TIMEOUT_MS: '500', TTLAB_WEB_ROOT: process.cwd(), TTLAB_LOG_DIR: logDir, TTLAB_RELEASE_DIR: join(root, 'releases'), TTLAB_PUBLIC_BASE_URL: `http://127.0.0.1:${port}` }, stdio: ['pipe', 'pipe', 'pipe'] });
  const sockets: WebSocket[] = [];
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));
    const payload = Buffer.from('fake-gd32-firmware-binary');

    // upload a firmware release
    const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/v1/firmware/releases/V39?artifact=Panda_COM-V39-release.bin&deviceType=tv-stick-test-box&description=test`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload });
    assert.equal(uploadResponse.status, 201);
    const uploaded = (await uploadResponse.json()).data;
    assert.equal(uploaded.sha256.length, 64);
    assert.deepEqual(uploaded.deviceTypes, ['tv-stick-test-box']);

    // duplicate upload is rejected
    const duplicate = await fetch(`http://127.0.0.1:${port}/api/v1/firmware/releases/V39?artifact=Panda_COM-V39-release.bin`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload });
    assert.equal(duplicate.status, 409);

    // list shows the firmware release
    const listResponse = await fetch(`http://127.0.0.1:${port}/api/v1/firmware/releases`);
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()).data;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].version, 'V39');
    assert.deepEqual(listed[0].deviceTypes, ['tv-stick-test-box']);

    // bring a client online so firmware.flash can be dispatched
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/session`);
    sockets.push(socket);
    await once(socket, 'open');
    const syncPromise = waitForMessage(socket, (value) => value.type === 'sync.request');
    socket.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-fw', platform: 'linux', architecture: 'amd64', capabilities: ['serial', 'firmware-flash'] }, 'client-fw')));
    await syncPromise;
    const serialPort = { deviceId: 'serial:fw', path: '/dev/ttyACM0', stableIdentity: true, status: 'available' as const, portRole: 'control' as const, observedAt: new Date().toISOString() };
    const operations: DeviceOperation[] = [{ operation: 'firmware.flash', displayName: '固件刷写', command: '', parameters: [{ name: 'version', type: 'string', pattern: '^[A-Za-z0-9._-]+$' }, { name: 'artifact', type: 'string', pattern: '^[A-Za-z0-9._-]+$' }] }];
    const managed: ManagedDevice = { deviceId: 'tvbox:fw', deviceType: 'tv-stick-test-box', displayName: 'TV Stick Test Box', stableIdentity: 'tvbox-fw', status: 'identified', ports: [serialPort], capabilities: ['firmware-flash'], operations, observedAt: serialPort.observedAt };
    const snapshot: ClientSnapshot = { snapshotRevision: 1, clientVersion: 'test', bootId: 'boot-fw', health: 'healthy', devices: [serialPort], managedDevices: [managed] };
    socket.send(JSON.stringify(message('client.snapshot', snapshot, 'client-fw')));

    // dispatch firmware.flash; the client must receive a command with the firmware download reference
    const executePromise = waitForMessage(socket, (value) => value.type === 'command.execute');
    const dispatchResponse = await fetch(`http://127.0.0.1:${port}/api/v1/clients/client-fw/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'tvbox:fw', operation: 'firmware.flash', parameters: { version: 'V39', artifact: 'Panda_COM-V39-release.bin' } }) });
    assert.equal(dispatchResponse.status, 202);
    const commandId = (await dispatchResponse.json()).data.commandId as string;
    const execute = await executePromise;
    const commandPayload = execute.payload as { commandId: string; firmware?: { release: string; artifact: string; downloadUrl: string; sha256: string; expiresAt: string } };
    assert.equal(commandPayload.commandId, commandId);
    assert.equal(commandPayload.firmware?.release, 'V39');
    assert.equal(commandPayload.firmware?.artifact, 'Panda_COM-V39-release.bin');
    assert.equal(commandPayload.firmware?.sha256, uploaded.sha256);
    assert.match(commandPayload.firmware?.downloadUrl ?? '', /\/agent\/v1\/releases\/V39\/Panda_COM-V39-release\.bin\?clientId=client-fw/);

    // the client downloads the firmware artifact and reports progress and result
    const downloadResponse = await fetch(commandPayload.firmware?.downloadUrl as string);
    assert.equal(downloadResponse.status, 200);
    assert.equal(await downloadResponse.text(), payload.toString('utf8'));
    socket.send(JSON.stringify(message('command.progress', { commandId, deviceId: 'tvbox:fw', stage: 'flashing', progress: 50, message: 'writing' }, 'client-fw', execute.id)));
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/v1/commands/${commandId}`);
    assert.equal((await statusResponse.json()).data.progress?.stage, 'flashing');
    socket.send(JSON.stringify(message('command.result', { commandId, deviceId: 'tvbox:fw', success: true, output: 'flashed V39' }, 'client-fw', execute.id)));
    const done = await fetch(`http://127.0.0.1:${port}/api/v1/commands/${commandId}`);
    assert.equal((await done.json()).data.status, 'result');
  } finally {
    for (const socket of sockets) socket.close();
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Server firmware supports multiple device types, lists categories and rejects mismatched flashes', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-fw-srv-'));
  const deviceTypesDir = join(root, 'device-types');
  mkdirSync(join(deviceTypesDir, 'tv-stick-test-box'), { recursive: true });
  writeFileSync(join(deviceTypesDir, 'tv-stick-test-box', 'device.json'), JSON.stringify({ type: 'tv-stick-test-box', displayName: 'TV Stick Test Box' }));
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], { cwd: process.cwd(), env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_HEARTBEAT_TIMEOUT_MS: '500', TTLAB_WEB_ROOT: process.cwd(), TTLAB_LOG_DIR: join(root, 'logs'), TTLAB_RELEASE_DIR: join(root, 'releases'), TTLAB_DEVICE_TYPES_DIR: deviceTypesDir, TTLAB_PUBLIC_BASE_URL: `http://127.0.0.1:${port}` }, stdio: ['pipe', 'pipe', 'pipe'] });
  const sockets: WebSocket[] = [];
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));
    const payload = Buffer.from('fake-gd32-firmware-binary');

    // device types are listed from the static device-types directory
    const deviceTypesResponse = await fetch(`http://127.0.0.1:${port}/api/v1/device-types`);
    assert.equal(deviceTypesResponse.status, 200);
    const deviceTypes = (await deviceTypesResponse.json()).data as Array<{ type: string; displayName: string }>;
    assert.ok(deviceTypes.some((item) => item.type === 'tv-stick-test-box' && item.displayName === 'TV Stick Test Box'));

    // upload a firmware release tagged for two device types
    const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/v1/firmware/releases/V50?artifact=multi.bin&deviceType=tv-stick-test-box&deviceType=acme-box&description=multi`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload });
    assert.equal(uploadResponse.status, 201);
    const uploaded = (await uploadResponse.json()).data;
    assert.deepEqual(uploaded.deviceTypes, ['tv-stick-test-box', 'acme-box']);

    // an unsafe device type is rejected
    const invalid = await fetch(`http://127.0.0.1:${port}/api/v1/firmware/releases/V51?artifact=bad.bin&deviceType=../evil`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload });
    assert.equal(invalid.status, 400);

    // bring a client online with an 'acme-box' managed device
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/session`);
    sockets.push(socket);
    await once(socket, 'open');
    const syncPromise = waitForMessage(socket, (value) => value.type === 'sync.request');
    socket.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-multi', platform: 'linux', architecture: 'amd64', capabilities: ['serial', 'firmware-flash'] }, 'client-multi')));
    await syncPromise;
    const serialPort = { deviceId: 'serial:multi', path: '/dev/ttyACM0', stableIdentity: true, status: 'available' as const, portRole: 'control' as const, observedAt: new Date().toISOString() };
    const operations: DeviceOperation[] = [{ operation: 'firmware.flash', displayName: '固件刷写', command: '', parameters: [{ name: 'version', type: 'string' }, { name: 'artifact', type: 'string' }] }];
    const managed: ManagedDevice = { deviceId: 'tvbox:acme', deviceType: 'acme-box', displayName: 'Acme Box', stableIdentity: 'acme-1', status: 'identified', ports: [serialPort], capabilities: ['firmware-flash'], operations, observedAt: serialPort.observedAt };
    socket.send(JSON.stringify(message('client.snapshot', { snapshotRevision: 1, clientVersion: 'test', bootId: 'boot-multi', health: 'healthy', devices: [serialPort], managedDevices: [managed] }, 'client-multi')));

    // the device-types endpoint also includes categories reported by online devices
    const refreshed = (await (await fetch(`http://127.0.0.1:${port}/api/v1/device-types`)).json()).data as Array<{ type: string; displayName: string }>;
    assert.ok(refreshed.some((item) => item.type === 'acme-box'));

    // a device covered by one of the firmware's device types can flash it
    const matched = await fetch(`http://127.0.0.1:${port}/api/v1/clients/client-multi/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'tvbox:acme', operation: 'firmware.flash', parameters: { version: 'V50', artifact: 'multi.bin' } }) });
    assert.equal(matched.status, 202);

    // a device whose type is not covered by the firmware is rejected
    const other: ManagedDevice = { ...managed, deviceId: 'tvbox:other', deviceType: 'other-box', stableIdentity: 'other-1' };
    socket.send(JSON.stringify(message('client.snapshot', { snapshotRevision: 2, clientVersion: 'test', bootId: 'boot-multi', health: 'healthy', devices: [serialPort], managedDevices: [other] }, 'client-multi')));
    const mismatched = await fetch(`http://127.0.0.1:${port}/api/v1/clients/client-multi/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'tvbox:other', operation: 'firmware.flash', parameters: { version: 'V50', artifact: 'multi.bin' } }) });
    assert.equal(mismatched.status, 400);
    assert.match(JSON.stringify(await mismatched.json()), /does not match the device type/);
  } finally {
    for (const socket of sockets) socket.close();
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Server firmware download requires a client id', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-fw-srv-'));
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], { cwd: process.cwd(), env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_WEB_ROOT: process.cwd(), TTLAB_LOG_DIR: join(root, 'logs'), TTLAB_RELEASE_DIR: join(root, 'releases') }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));
    const upload = await fetch(`http://127.0.0.1:${port}/api/v1/firmware/releases/V1?artifact=a.bin`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('x') });
    assert.equal(upload.status, 201);
    const missingClient = await fetch(`http://127.0.0.1:${port}/agent/v1/releases/V1/a.bin`);
    assert.equal(missingClient.status, 404);
    const valid = await fetch(`http://127.0.0.1:${port}/agent/v1/releases/V1/a.bin?clientId=client-x`);
    assert.equal(valid.status, 200);
    assert.equal(await valid.text(), 'x');
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Server rejects firmware.flash for a release that does not exist', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-fw-srv-'));
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], { cwd: process.cwd(), env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_HEARTBEAT_TIMEOUT_MS: '500', TTLAB_WEB_ROOT: process.cwd(), TTLAB_LOG_DIR: join(root, 'logs'), TTLAB_RELEASE_DIR: join(root, 'releases') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const sockets: WebSocket[] = [];
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/session`);
    sockets.push(socket);
    await once(socket, 'open');
    const syncPromise = waitForMessage(socket, (value) => value.type === 'sync.request');
    socket.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-miss', platform: 'linux', architecture: 'amd64', capabilities: ['serial', 'firmware-flash'] }, 'client-miss')));
    await syncPromise;
    const serialPort = { deviceId: 'serial:miss', path: '/dev/ttyACM0', stableIdentity: true, status: 'available' as const, portRole: 'control' as const, observedAt: new Date().toISOString() };
    const operations: DeviceOperation[] = [{ operation: 'firmware.flash', displayName: '固件刷写', command: '', parameters: [{ name: 'version', type: 'string' }, { name: 'artifact', type: 'string' }] }];
    const managed: ManagedDevice = { deviceId: 'tvbox:miss', deviceType: 'tv-stick-test-box', displayName: 'TV Stick Test Box', stableIdentity: 'tvbox-miss', status: 'identified', ports: [serialPort], capabilities: ['firmware-flash'], operations, observedAt: serialPort.observedAt };
    socket.send(JSON.stringify(message('client.snapshot', { snapshotRevision: 1, clientVersion: 'test', bootId: 'boot-miss', health: 'healthy', devices: [serialPort], managedDevices: [managed] }, 'client-miss')));
    const missing = await fetch(`http://127.0.0.1:${port}/api/v1/clients/client-miss/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'tvbox:miss', operation: 'firmware.flash', parameters: { version: 'NOPE', artifact: 'a.bin' } }) });
    assert.equal(missing.status, 400);
    assert.match(JSON.stringify(await missing.json()), /RELEASE_NOT_FOUND/);
  } finally {
    for (const socket of sockets) socket.close();
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
