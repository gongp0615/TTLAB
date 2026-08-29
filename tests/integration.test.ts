import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import test from 'node:test';
import WebSocket from 'ws';
import { message, parseEnvelope, type ClientSnapshot } from '../packages/protocol/src/index.js';

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

test('Server and protocol Client complete sync, command result, disconnect, and reconnect', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], { cwd: process.cwd(), env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_HEARTBEAT_TIMEOUT_MS: '500', TTLAB_WEB_ROOT: process.cwd() }, stdio: ['pipe', 'pipe', 'pipe'] });
  const sockets: WebSocket[] = [];
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/session`);
    sockets.push(socket);
    await once(socket, 'open');
    const syncPromise = waitForMessage(socket, (value) => value.type === 'sync.request');
    socket.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-e2e', platform: 'linux', architecture: 'amd64', capabilities: ['serial'] }, 'client-e2e')));
    await syncPromise;
    const snapshot: ClientSnapshot = { snapshotRevision: 1, clientVersion: 'test', bootId: 'boot-e2e', health: 'healthy', devices: [{ deviceId: 'serial:e2e', path: '/dev/ttyE2E', stableIdentity: true, status: 'available', observedAt: new Date().toISOString() }] };
    socket.send(JSON.stringify(message('client.snapshot', snapshot, 'client-e2e')));
    const devicesResponse = await fetch(`http://127.0.0.1:${port}/api/v1/devices`);
    assert.equal(devicesResponse.status, 200);
    assert.equal((await devicesResponse.json()).data[0].deviceId, 'serial:e2e');

    const executePromise = waitForMessage(socket, (value) => value.type === 'command.execute');
    const commandResponse = await fetch(`http://127.0.0.1:${port}/api/v1/clients/client-e2e/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'serial:e2e', operation: 'system.ping', parameters: {} }) });
    assert.equal(commandResponse.status, 202);
    const commandId = (await commandResponse.json()).data.commandId as string;
    const execute = await executePromise;
    assert.equal((execute.payload as { commandId: string }).commandId, commandId);
    socket.send(JSON.stringify(message('command.accepted', { commandId, deviceId: 'serial:e2e' }, 'client-e2e', execute.id)));
    socket.send(JSON.stringify(message('command.result', { commandId, deviceId: 'serial:e2e', success: true, output: 'PONG' }, 'client-e2e', execute.id)));
    const commandStatus = await fetch(`http://127.0.0.1:${port}/api/v1/commands/${commandId}`);
    assert.equal((await commandStatus.json()).data.result.output, 'PONG');

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const offline = await fetch(`http://127.0.0.1:${port}/api/v1/clients`);
    assert.equal((await offline.json()).data[0].status, 'offline');

    const reconnect = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/session`);
    sockets.push(reconnect);
    await once(reconnect, 'open');
    const reconnectSyncPromise = waitForMessage(reconnect, (value) => value.type === 'sync.request');
    reconnect.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-e2e-2', platform: 'linux', architecture: 'amd64', capabilities: ['serial'] }, 'client-e2e')));
    await reconnectSyncPromise;
    reconnect.send(JSON.stringify(message('client.snapshot', { ...snapshot, bootId: 'boot-e2e-2', snapshotRevision: 1 }, 'client-e2e')));
    const online = await fetch(`http://127.0.0.1:${port}/api/v1/clients`);
    assert.equal((await online.json()).data[0].status, 'online');
  } finally {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
  }
});

test('Server serves HTTPS and accepts authenticated WSS when TLS is configured', async () => {
  if (!existsSync('/usr/bin/openssl')) return;
  const root = mkdtempSync(join(tmpdir(), 'ttlab-tls-'));
  const keyFile = join(root, 'server.key');
  const certFile = join(root, 'server.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], { cwd: process.cwd(), env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_CLIENT_TOKENS: 'client-tls=tls-token', TTLAB_CLIENT_AUTH_ENABLED: '1', TTLAB_TLS_REQUIRED: '1', TTLAB_TLS_KEY_FILE: keyFile, TTLAB_TLS_CERT_FILE: certFile, TTLAB_WEB_ROOT: process.cwd() }, stdio: ['pipe', 'pipe', 'pipe'] });
  let socket: WebSocket | undefined;
  try {
    await waitForOutput(child, (line) => line.includes('"tls":true'));
    const health = await new Promise<string>((resolve, reject) => {
      const request = https.get(`https://127.0.0.1:${port}/healthz`, { rejectUnauthorized: false }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve(body));
      });
      request.on('error', reject);
    });
    assert.equal(JSON.parse(health).status, 'ok');
    socket = new WebSocket(`wss://127.0.0.1:${port}/agent/v1/session`, { rejectUnauthorized: false, headers: { Authorization: 'Bearer tls-token' } });
    await once(socket, 'open');
    const syncPromise = waitForMessage(socket, (value) => value.type === 'sync.request');
    socket.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-tls', platform: 'linux', architecture: 'amd64', capabilities: ['serial'] }, 'client-tls')));
    const sync = await syncPromise;
    assert.equal(sync.type, 'sync.request');
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('the actual Client process registers, persists identity, and reconnects', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-e2e-'));
  const server = spawn(process.execPath, ['dist/apps/server/src/index.js'], { cwd: process.cwd(), env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_HEARTBEAT_TIMEOUT_MS: '500', TTLAB_WEB_ROOT: process.cwd() }, stdio: ['pipe', 'pipe', 'pipe'] });
  let client: ChildProcessWithoutNullStreams | undefined;
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const clientEnv = { ...process.env, TTLAB_SERVER_URL: `ws://127.0.0.1:${port}/agent/v1/session`, TTLAB_STATE_DIR: join(root, 'state'), TTLAB_HEARTBEAT_MS: '100' };
    client = spawn(process.execPath, ['dist/apps/client/src/index.js'], { cwd: process.cwd(), env: clientEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const started = waitForOutput(client, (line) => line.includes('client_started'));
    await started;
    await waitUntil(() => isClientOnline(port));
    assert.equal(existsSync(join(root, 'state', 'client-id')), true);
    client.kill('SIGTERM');
    await once(client, 'exit');
    client = spawn(process.execPath, ['dist/apps/client/src/index.js'], { cwd: process.cwd(), env: clientEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForOutput(client, (line) => line.includes('client_started'));
    await waitUntil(() => isClientOnline(port));
  } finally {
    if (client?.exitCode === null) { client.kill('SIGTERM'); await once(client, 'exit').catch(() => undefined); }
    if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit').catch(() => undefined); }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Server loads runtime settings from the startup directory config file', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-server-config-'));
  const configFile = join(root, 'server.env');
  writeFileSync(configFile, `TTLAB_SERVER_PORT=${port}\nTTLAB_PUBLIC_BASE_URL=http://127.0.0.1:${port}\nTTLAB_CLIENT_AUTH_ENABLED=0\n`);
  const environment: NodeJS.ProcessEnv = { ...process.env, TTLAB_CONFIG_FILE: configFile, TTLAB_WEB_ROOT: process.cwd() };
  delete environment.TTLAB_SERVER_PORT;
  const server = spawn(process.execPath, ['dist/apps/server/src/index.js'], { cwd: process.cwd(), env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await waitForOutput(server, (line) => line.includes(`"port":${port}`));
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit').catch(() => undefined); }
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timeout');
}

async function isClientOnline(port: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/clients`);
  const body = await response.json() as { data?: Array<{ status?: string }> };
  return body.data?.[0]?.status === 'online';
}
