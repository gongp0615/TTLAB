import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import {
  parseEnvelope,
  type ClientSnapshot,
  type CommandRequest,
  type DeviceLogChunk,
  type MessageType,
  type SerialDevice,
} from '../packages/protocol/src/index.js';
import { ClientAgent } from '../apps/client/src/agent.js';
import type { SerialAdapter } from '../apps/client/src/serial.js';
import type { FirmwareFlasher, FlashContext } from '../apps/client/src/firmware-flasher.js';
import type { SerialPortInfo } from '../apps/client/src/discovery.js';

const tvBoxDeviceId = 'tvbox:28e9:018a:FAKE';

const controlPort: SerialPortInfo = {
  deviceId: 'serial:usb-GigaDevice_GD32-CDC_ACM_FAKE-if00',
  path: '/dev/ttyACM0',
  stableIdentity: true,
  vendorId: '28e9',
  productId: '018a',
  serialNumber: 'FAKE',
  hardwareKey: '28e9:018a:FAKE',
  interfaceNumber: '00',
  deviceType: 'tv-stick-test-box',
  status: 'available',
  observedAt: new Date().toISOString(),
};

const logPort = (path: string): SerialPortInfo => ({
  ...controlPort,
  deviceId: 'serial:usb-GigaDevice_GD32-CDC_ACM_FAKE-if02',
  path,
  interfaceNumber: '02',
});

class FakeSerialAdapter implements SerialAdapter {
  readonly calls: Array<{ request: CommandRequest; device: SerialDevice }> = [];
  failure: { code: string; message: string; retryable: boolean } | undefined;
  gate: Promise<void> | undefined;

  async execute(request: CommandRequest, device: SerialDevice) {
    this.calls.push({ request, device });
    if (this.gate) await this.gate;
    if (this.failure) return { commandId: request.commandId, deviceId: request.deviceId, success: false, error: this.failure };
    return { commandId: request.commandId, deviceId: request.deviceId, success: true, output: 'PING:OK' };
  }
}

class FakeFirmwareFlasher implements FirmwareFlasher {
  readonly contexts: FlashContext[] = [];
  failure: { code: string; message: string; retryable: boolean } | undefined;
  gate: Promise<void> | undefined;

  async flash(context: FlashContext) {
    this.contexts.push(context);
    if (this.gate) await this.gate;
    if (this.failure) return { commandId: context.request.commandId, deviceId: context.request.deviceId, success: false, error: this.failure };
    return { commandId: context.request.commandId, deviceId: context.request.deviceId, success: true, output: 'flashed V39 (test)' };
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startServer(port: number, extraEnv: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  const logDir = mkdtempSync(join(tmpdir(), 'ttlab-it-logs-'));
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_WEB_ROOT: process.cwd(), TTLAB_LOG_DIR: logDir, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return Object.assign(child, { logDir });
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
  }
  const logDir = (child as ChildProcessWithoutNullStreams & { logDir?: string }).logDir;
  if (logDir) rmSync(logDir, { recursive: true, force: true });
}

function waitForOutput(child: ChildProcessWithoutNullStreams, match: (line: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 10_000);
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

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timeout');
}

async function getClient(port: number, clientId: string): Promise<{ status: string; snapshot?: ClientSnapshot } | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/clients`);
  const body = await response.json() as { data?: Array<{ clientId: string; status: string; snapshot?: ClientSnapshot }> };
  return body.data?.find((candidate) => candidate.clientId === clientId);
}

async function waitClientOnline(port: number, clientId: string): Promise<void> {
  await waitUntil(async () => {
    const client = await getClient(port, clientId);
    return client?.status === 'online' && client.snapshot !== undefined;
  });
}

async function postCommand(port: number, clientId: string, deviceId: string, operation = 'system.ping', parameters: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/v1/clients/${clientId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, operation, parameters }),
  });
}

async function commandStatus(port: number, commandId: string): Promise<{ status: string; result?: { success?: boolean; output?: string; error?: { code?: string } } }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/commands/${commandId}`);
  const body = await response.json() as { data: { status: string; result?: { success?: boolean; output?: string; error?: { code?: string } } } };
  return body.data;
}

interface AgentTestOptions {
  port: number;
  stateDir: string;
  adapter?: SerialAdapter;
  flasher?: FirmwareFlasher;
  discoverPorts?: () => SerialPortInfo[];
  controlSelector?: string;
  logSelector?: string;
  onSend?: (type: MessageType, payload: unknown, correlationId?: string | undefined) => void;
  heartbeatMs?: number;
}

function startAgent(options: AgentTestOptions): ClientAgent {
  const agent = new ClientAgent({
    serverUrl: `ws://127.0.0.1:${options.port}/agent/v1/session`,
    stateDirectory: options.stateDir,
    heartbeatMs: options.heartbeatMs ?? 100,
    refreshIntervalMs: 60_000,
    controlSelector: options.controlSelector,
    logSelector: options.logSelector,
    adapter: options.adapter,
    flasher: options.flasher,
    discoverPorts: options.discoverPorts,
    onSend: options.onSend,
  });
  agent.start();
  return agent;
}

function waitForEvent(socket: WebSocket, predicate: (value: ReturnType<typeof parseEnvelope>) => boolean): Promise<ReturnType<typeof parseEnvelope>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket event timeout')), 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      const value = parseEnvelope(data.toString());
      if (predicate(value)) { clearTimeout(timeout); socket.off('message', onMessage); resolve(value); }
    };
    socket.on('message', onMessage);
  });
}

const ptyScript = [
  'import os, pty, sys',
  'master, slave = pty.openpty()',
  'print(os.ttyname(slave), flush=True)',
  'while True:',
  '    line = sys.stdin.readline()',
  '    if line == "":',
  '        break',
  '    os.write(master, line.encode("utf-8", "replace"))',
].join('\n');

interface PtySession {
  path: string;
  write(data: string): void;
  close(): void;
}

async function createPty(): Promise<PtySession> {
  const child = spawn('python3', ['-c', ptyScript], { stdio: ['pipe', 'pipe', 'ignore'] });
  const path = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('pty creation timeout')), 10_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1) { clearTimeout(timeout); child.stdout.off('data', onData); resolve((lines[0] ?? '').trim()); }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`pty process exited with ${code}`)); });
  });
  return {
    path,
    write: (data) => { if (child.stdin) child.stdin.write(data); },
    close: () => { child.stdin?.end(); child.kill('SIGKILL'); },
  };
}

test('client registers, syncs its snapshot and stays online via heartbeats', async () => {
  const port = await freePort();
  const server = startServer(port, { TTLAB_HEARTBEAT_TIMEOUT_MS: '500' });
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const agent = startAgent({ port, stateDir: join(root, 'state'), discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId });
    try {
      await waitClientOnline(port, agent.clientId);
      const client = await getClient(port, agent.clientId);
      assert.equal(client?.status, 'online');
      assert.equal(client?.snapshot?.devices.length, 1);
      assert.equal(client?.snapshot?.devices[0]?.deviceId, controlPort.deviceId);
      assert.equal(client?.snapshot?.managedDevices?.[0]?.deviceId, tvBoxDeviceId);
      assert.equal(client?.snapshot?.managedDevices?.[0]?.status, 'identified');
      const devicesResponse = await fetch(`http://127.0.0.1:${port}/api/v1/devices`);
      const devices = await devicesResponse.json() as { data: Array<{ deviceId: string; clientId: string }> };
      assert.equal(devices.data.some((device) => device.deviceId === tvBoxDeviceId && device.clientId === agent.clientId), true);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal((await getClient(port, agent.clientId))?.status, 'online');
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('client executes a command end-to-end and the server records the result', async () => {
  const port = await freePort();
  const server = startServer(port);
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const adapter = new FakeSerialAdapter();
    const agent = startAgent({ port, stateDir: join(root, 'state'), discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId, adapter });
    try {
      await waitClientOnline(port, agent.clientId);
      const response = await postCommand(port, agent.clientId, tvBoxDeviceId);
      assert.equal(response.status, 202);
      const { data } = await response.json() as { data: { commandId: string } };
      await waitUntil(async () => {
        const status = await commandStatus(port, data.commandId);
        return status.status === 'result' && status.result?.output === 'PING:OK';
      });
      assert.equal(adapter.calls.length, 1);
      assert.equal(adapter.calls[0]?.request.deviceId, tvBoxDeviceId);
      assert.equal(adapter.calls[0]?.request.operation, 'system.ping');
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('client reports failed commands and rejects concurrent commands for the same device', async () => {
  const port = await freePort();
  const server = startServer(port);
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const adapter = new FakeSerialAdapter();
    const agent = startAgent({ port, stateDir: join(root, 'state'), discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId, adapter });
    try {
      await waitClientOnline(port, agent.clientId);

      adapter.failure = { code: 'SERIAL_ERROR', message: 'simulated failure', retryable: true };
      let response = await postCommand(port, agent.clientId, tvBoxDeviceId);
      assert.equal(response.status, 202);
      const failed = (await response.json()) as { data: { commandId: string } };
      await waitUntil(async () => {
        const status = await commandStatus(port, failed.data.commandId);
        return status.status === 'failed' && status.result?.error?.code === 'SERIAL_ERROR';
      });

      adapter.failure = undefined;
      let release!: () => void;
      adapter.gate = new Promise<void>((resolve) => { release = resolve; });
      response = await postCommand(port, agent.clientId, tvBoxDeviceId);
      const first = (await response.json()) as { data: { commandId: string } };
      await waitUntil(async () => adapter.calls.length === 2);
      response = await postCommand(port, agent.clientId, tvBoxDeviceId);
      const second = (await response.json()) as { data: { commandId: string } };
      await waitUntil(async () => {
        const status = await commandStatus(port, second.data.commandId);
        return status.status === 'failed' && status.result?.error?.code === 'SERIAL_BUSY';
      });
      release();
      await waitUntil(async () => {
        const status = await commandStatus(port, first.data.commandId);
        return status.status === 'result' && status.result?.output === 'PING:OK';
      });
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('client rejects an expired command with COMMAND_EXPIRED', async () => {
  const port = await freePort();
  const server = startServer(port);
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const sent: Array<{ type: string; payload: Record<string, unknown>; correlationId?: string | undefined }> = [];
    const agent = startAgent({
      port,
      stateDir: join(root, 'state'),
      discoverPorts: () => [controlPort],
      controlSelector: controlPort.deviceId,
      onSend: (type, payload, correlationId) => sent.push({ type, payload: payload as Record<string, unknown>, correlationId }),
    });
    try {
      await waitClientOnline(port, agent.clientId);
      const expired: CommandRequest = {
        commandId: 'cmd_expired',
        deviceId: tvBoxDeviceId,
        operation: 'system.ping',
        parameters: {},
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      };
      agent.receiveCommandExecute(expired, 'corr-expired');
      await waitUntil(async () => sent.some((item) => item.type === 'command.failed' && item.payload.commandId === 'cmd_expired'));
      const failed = sent.find((item) => item.type === 'command.failed');
      assert.equal((failed?.payload as { error?: { code?: string } }).error?.code, 'COMMAND_EXPIRED');
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('server rejects commands targeting unknown devices or offline clients', async () => {
  const port = await freePort();
  const server = startServer(port);
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const agent = startAgent({ port, stateDir: join(root, 'state'), discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId });
    try {
      await waitClientOnline(port, agent.clientId);
      let response = await postCommand(port, agent.clientId, 'unknown-device');
      assert.equal(response.status, 409);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'DEVICE_OFFLINE');
      await agent.stop();
      await waitUntil(async () => (await getClient(port, agent.clientId))?.status === 'offline');
      response = await postCommand(port, agent.clientId, tvBoxDeviceId);
      assert.equal(response.status, 409);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'CLIENT_OFFLINE');
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('client reflects serial port hot-plug changes in subsequent snapshots', async () => {
  const port = await freePort();
  const server = startServer(port);
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    let ports: SerialPortInfo[] = [controlPort];
    const agent = startAgent({ port, stateDir: join(root, 'state'), discoverPorts: () => ports, controlSelector: controlPort.deviceId, logSelector: logPort('/dev/ttyACM2').deviceId });
    try {
      await waitClientOnline(port, agent.clientId);
      assert.equal((await getClient(port, agent.clientId))?.snapshot?.devices.length, 1);

      ports = [controlPort, logPort('/dev/ttyACM2')];
      await agent.refreshDevices(true);
      await waitUntil(async () => (await getClient(port, agent.clientId))?.snapshot?.devices.length === 2);

      ports = [controlPort];
      await agent.refreshDevices(true);
      await waitUntil(async () => (await getClient(port, agent.clientId))?.snapshot?.devices.length === 1);
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('client captures serial log output and forwards log chunks', async () => {
  const pty = await createPty();
  const port = await freePort();
  const server = startServer(port);
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const logPortDevice = logPort(pty.path);
    const agent = startAgent({
      port,
      stateDir: join(root, 'state'),
      discoverPorts: () => [controlPort, logPortDevice],
      controlSelector: controlPort.deviceId,
      logSelector: logPortDevice.deviceId,
    });
    try {
      await waitClientOnline(port, agent.clientId);
      await agent.refreshDevices(true);
      const viewer = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`);
      await once(viewer, 'open');
      viewer.send(JSON.stringify({ type: 'log.subscribe', deviceId: tvBoxDeviceId }));
      const logPromise = waitForEvent(viewer, (value) => value.type === 'device.log.chunk');
      pty.write('boot complete\n');
      const envelope = await logPromise;
      const chunk = envelope.payload as DeviceLogChunk;
      assert.equal(chunk.deviceId, tvBoxDeviceId);
      assert.equal(chunk.portId, logPortDevice.deviceId);
      assert.equal(chunk.data.includes('boot complete'), true);
      assert.equal(chunk.encoding, 'utf-8');
      assert.equal(chunk.truncated, false);
      assert.ok(chunk.sequence >= 1);
      viewer.close();
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
    pty.close();
  }
});

test('client reconnects and resends the full snapshot after a server restart', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  let server = startServer(port, { TTLAB_HEARTBEAT_TIMEOUT_MS: '1000' });
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const agent = startAgent({ port, stateDir: join(root, 'state'), discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId });
    try {
      await waitClientOnline(port, agent.clientId);
      await stopServer(server);
      server = startServer(port, { TTLAB_HEARTBEAT_TIMEOUT_MS: '1000' });
      await waitForOutput(server, (line) => line.includes('server_started'));
      await waitClientOnline(port, agent.clientId);
      const client = await getClient(port, agent.clientId);
      assert.equal(client?.status, 'online');
      assert.equal(client?.snapshot?.devices.length, 1);
      assert.equal(client?.snapshot?.managedDevices?.[0]?.status, 'identified');
      assert.equal(client?.snapshot?.bootId, agent.bootId);
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('client persists its identity across restarts', async () => {
  const port = await freePort();
  const server = startServer(port);
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const stateDir = join(root, 'state');
    const agent1 = startAgent({ port, stateDir, discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId });
    try {
      await waitClientOnline(port, agent1.clientId);
      const id1 = agent1.clientId;
      const boot1 = agent1.bootId;
      await agent1.stop();
      const agent2 = startAgent({ port, stateDir, discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId });
      try {
        await waitClientOnline(port, agent2.clientId);
        assert.equal(agent2.clientId, id1);
        const client = await getClient(port, id1);
        assert.equal(client?.status, 'online');
        assert.equal(client?.snapshot?.bootId, agent2.bootId);
        assert.notEqual(agent2.bootId, boot1);
      } finally {
        await agent2.stop();
      }
    } finally {
      await agent1.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('client flashes firmware end to end: dispatch, download reference, progress and result', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  const server = startServer(port, { TTLAB_HEARTBEAT_TIMEOUT_MS: '1000', TTLAB_RELEASE_DIR: join(root, 'releases'), TTLAB_PUBLIC_BASE_URL: `http://127.0.0.1:${port}` });
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));

    // publish a firmware release on the server
    const payload = Buffer.from('fake-firmware-binary');
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const upload = await fetch(`http://127.0.0.1:${port}/api/v1/firmware/releases/V39?artifact=test.bin&deviceType=tv-stick-test-box`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload });
    assert.equal(upload.status, 201);

    const adapter = new FakeSerialAdapter();
    const flasher = new FakeFirmwareFlasher();
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const agent = startAgent({ port, stateDir: join(root, 'state'), discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId, adapter, flasher, onSend: (type, payload) => sent.push({ type, payload: payload as Record<string, unknown> }) });
    try {
      await waitClientOnline(port, agent.clientId);

      const dispatch = await postCommand(port, agent.clientId, tvBoxDeviceId, 'firmware.flash', { version: 'V39', artifact: 'test.bin' });
      assert.equal(dispatch.status, 202);
      const commandId = (await dispatch.json()).data.commandId as string;

      // the client flasher runs automatically; assert it received the firmware reference
      await waitUntil(async () => flasher.contexts.length > 0);
      assert.equal(flasher.contexts[0]?.request.firmware?.release, 'V39');
      assert.equal(flasher.contexts[0]?.request.firmware?.sha256, sha256);
      assert.equal(flasher.contexts[0]?.request.firmware?.artifact, 'test.bin');

      await waitUntil(async () => {
        const status = await commandStatus(port, commandId);
        return status.status === 'result' || status.status === 'failed';
      });
      const status = await commandStatus(port, commandId);
      assert.equal(status.status, 'result');
      assert.equal(status.result?.success, true);
      assert.match(status.result?.output ?? '', /flashed V39/);

      // the client reported accepted then result
      assert.ok(sent.some((item) => item.type === 'command.accepted' && item.payload.commandId === commandId));
      assert.ok(sent.some((item) => item.type === 'command.result' && item.payload.commandId === commandId));
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('client rejects a firmware.flash command that has no firmware reference', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-client-it-'));
  const server = startServer(port, { TTLAB_HEARTBEAT_TIMEOUT_MS: '1000' });
  try {
    await waitForOutput(server, (line) => line.includes('server_started'));
    const flasher = new FakeFirmwareFlasher();
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const agent = startAgent({ port, stateDir: join(root, 'state'), discoverPorts: () => [controlPort], controlSelector: controlPort.deviceId, flasher, onSend: (type, payload) => sent.push({ type, payload: payload as Record<string, unknown> }) });
    try {
      await waitClientOnline(port, agent.clientId);
      const request: CommandRequest = { commandId: 'cmd-no-fw', deviceId: tvBoxDeviceId, operation: 'firmware.flash', parameters: {}, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
      agent.receiveCommandExecute(request, 'corr-no-fw');
      await waitUntil(async () => sent.some((item) => item.type === 'command.failed'));
      const failed = sent.find((item) => item.type === 'command.failed');
      assert.equal((failed?.payload as { error?: { code?: string } }).error?.code, 'INVALID_ARGUMENT');
      assert.equal(flasher.contexts.length, 0);
    } finally {
      await agent.stop();
    }
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});
