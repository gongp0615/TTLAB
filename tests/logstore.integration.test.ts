import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { message, parseEnvelope, type ClientSnapshot } from '../packages/protocol/src/index.js';
import type { LogEntry } from '../apps/server/src/logstore/index.js';

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

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timeout');
}

test('Server persists device logs, command lifecycle, and audit to the log store and exposes query APIs', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-logstore-e2e-'));
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_LOG_DIR: join(root, 'logs'), TTLAB_WEB_ROOT: process.cwd() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sockets: WebSocket[] = [];
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));

    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/session`);
    sockets.push(socket);
    await once(socket, 'open');
    const syncPromise = waitForMessage(socket, (value) => value.type === 'sync.request');
    socket.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-e2e', platform: 'linux', architecture: 'amd64', capabilities: ['serial'] }, 'client-e2e')));
    await syncPromise;

    // Web viewer 订阅 /api/v1/events，应实时收到 system.log（设备发现等系统消息）。
    // 注意 system.log 是 Server→Web 专用信封，parseEnvelope 的 knownTypes 不包含它，故用原始 JSON 解析。
    const viewer = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`);
    sockets.push(viewer);
    await once(viewer, 'open');
    let discoveredEnvelope: { type?: string; payload?: { data?: { action?: string }; deviceId?: string } } | undefined;
    const onViewerMessage = (data: WebSocket.RawData) => {
      let value: unknown;
      try { value = JSON.parse(data.toString()); } catch { return; }
      const envelope = value as { type?: string; payload?: { data?: { action?: string }; deviceId?: string } };
      if (envelope.type === 'system.log' && envelope.payload?.data?.action === 'device.discovered') discoveredEnvelope = envelope;
    };
    viewer.on('message', onViewerMessage);

    const serialPort = { deviceId: 'serial:e2e', path: '/dev/ttyE2E', stableIdentity: true, status: 'available' as const, portRole: 'control' as const, observedAt: new Date().toISOString() };
    const snapshot: ClientSnapshot = { snapshotRevision: 1, clientVersion: 'test', bootId: 'boot-e2e', health: 'healthy', devices: [serialPort], managedDevices: [{ deviceId: 'tvbox:e2e', deviceType: 'tv-stick-test-box', displayName: 'TV Stick Test Box', stableIdentity: 'tvbox-e2e', status: 'identified', ports: [serialPort], capabilities: ['serial-control'], observedAt: serialPort.observedAt }] };
    socket.send(JSON.stringify(message('client.snapshot', snapshot, 'client-e2e')));

    await waitUntil(async () => discoveredEnvelope !== undefined);
    viewer.off('message', onViewerMessage);
    assert.ok(['serial:e2e', 'tvbox:e2e'].includes(discoveredEnvelope?.payload?.deviceId as string), 'device.discovered must reference a device in the snapshot');

    // device log chunk must be persisted
    const capturedAt = new Date().toISOString();
    socket.send(JSON.stringify(message('device.log.chunk', { deviceId: 'tvbox:e2e', portId: 'serial:e2e-log', sequence: 7, capturedAt, data: 'boot complete\\n', encoding: 'utf-8', truncated: false }, 'client-e2e')));
    await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/logs/query?type=device&clientId=client-e2e&deviceId=tvbox%3Ae2e`);
      if (response.status !== 200) return false;
      const body = await response.json() as { data: LogEntry[] };
      return body.data.some((entry) => entry.data.sequence === 7);
    });

    // a dispatched command must produce command and audit entries
    const executePromise = waitForMessage(socket, (value) => value.type === 'command.execute');
    const commandResponse = await fetch(`http://127.0.0.1:${port}/api/v1/clients/client-e2e/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'tvbox:e2e', operation: 'system.ping', parameters: {} }) });
    assert.equal(commandResponse.status, 202);
    const commandId = (await commandResponse.json()).data.commandId as string;
    const execute = await executePromise;
    socket.send(JSON.stringify(message('command.accepted', { commandId, deviceId: 'tvbox:e2e' }, 'client-e2e', execute.id)));
    socket.send(JSON.stringify(message('command.result', { commandId, deviceId: 'tvbox:e2e', success: true, output: 'PONG' }, 'client-e2e', execute.id)));

    await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/logs/query?type=command&commandId=${commandId}`);
      if (response.status !== 200) return false;
      const body = await response.json() as { data: LogEntry[] };
      const statuses = body.data.map((entry) => (entry.data.status as string)).sort();
      return statuses.includes('dispatched') && statuses.includes('result');
    });

    const auditResponse = await fetch(`http://127.0.0.1:${port}/api/v1/audit?clientId=client-e2e&keyword=command.dispatch`);
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json() as { data: LogEntry[] };
    assert.ok(auditBody.data.some((entry) => entry.data.action === 'command.dispatch' && entry.data.operation === 'system.ping'));

    // client events must be persisted
    const eventResponse = await fetch(`http://127.0.0.1:${port}/api/v1/logs/query?type=event&clientId=client-e2e`);
    const eventBody = await eventResponse.json() as { data: LogEntry[] };
    const actions = eventBody.data.map((entry) => entry.data.action as string);
    assert.ok(actions.includes('client.connected'));
    assert.ok(actions.includes('client.online'));
    assert.ok(actions.includes('device.discovered'));

    // error log type is queryable and returns a well-formed response
    const errorResponse = await fetch(`http://127.0.0.1:${port}/api/v1/logs/query?type=error&limit=5`);
    assert.equal(errorResponse.status, 200);
    const errorBody = await errorResponse.json() as { data: LogEntry[] };
    assert.ok(errorBody.data.every((entry) => entry.type === 'error'));

    // reverse query returns the newest entries first
    const reverseResponse = await fetch(`http://127.0.0.1:${port}/api/v1/logs/query?type=event&limit=10&reverse=1`);
    assert.equal(reverseResponse.status, 200);
    const reverseBody = await reverseResponse.json() as { data: LogEntry[] };
    assert.ok(reverseBody.data.length > 0, 'reverse query must return event entries');
    const timestamps = reverseBody.data.map((entry) => entry.ts);
    assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b.localeCompare(a)), 'reverse must return newest first');

    // 触发一条协议错误，验证 reverse 模式下近期 error 也能被查询到
    socket.send('this is not a valid envelope');
    await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/logs/query?type=error&limit=5&reverse=1`);
      if (response.status !== 200) return false;
      const body = await response.json() as { data: LogEntry[] };
      return body.data.some((entry) => entry.data.code === 'PROTOCOL_ERROR');
    });

    // invalid reverse value must return INVALID_ARGUMENT
    const invalidReverse = await fetch(`http://127.0.0.1:${port}/api/v1/logs/query?type=event&reverse=abc`);
    assert.equal(invalidReverse.status, 400);
    assert.equal((await invalidReverse.json()).error.code, 'INVALID_ARGUMENT');

    // raw files must exist on disk for device logs
    const date = new Date().toISOString().slice(0, 10);
    const deviceFile = join(root, 'logs', 'device', date, 'client-e2e.jsonl');
    assert.equal(existsSync(deviceFile), true);
    assert.ok(readFileSync(deviceFile, 'utf8').includes('boot complete'));

    // invalid query parameters must return INVALID_ARGUMENT
    const invalid = await fetch(`http://127.0.0.1:${port}/api/v1/logs/query?type=bogus`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_ARGUMENT');

    // health endpoint reports log store status
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).logStore.healthy, true);
  } finally {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
