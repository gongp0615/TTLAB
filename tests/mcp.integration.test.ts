import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { message, parseEnvelope, type ClientSnapshot } from '../packages/protocol/src/index.js';
import type { JsonRpcResponse } from '../apps/server/src/mcp/index.js';

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

interface McpCallResult {
  status: number;
  contentType: string;
  body: unknown;
}

async function mcpCall(port: number, body: unknown, token?: string, accept?: string): Promise<McpCallResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (accept !== undefined) headers.accept = accept;
  const response = await fetch(`http://127.0.0.1:${port}/mcp/v1`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let parsed: unknown = null;
  if (text.length > 0) {
    if (contentType.startsWith('text/event-stream')) {
      const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
      parsed = dataLine !== undefined ? JSON.parse(dataLine.slice('data: '.length)) : null;
    } else {
      parsed = JSON.parse(text);
    }
  }
  return { status: response.status, contentType, body: parsed };
}

async function callTool(port: number, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const result = await mcpCall(port, { jsonrpc: '2.0', id: `call-${name}`, method: 'tools/call', params: { name, arguments: args } }, 'secret-token');
  assert.equal(result.status, 200);
  return result.body as JsonRpcResponse;
}

function toolPayload(result: JsonRpcResponse): { content: Array<{ text: string }>; isError: boolean } {
  return result.result as { content: Array<{ text: string }>; isError: boolean };
}

function textOf(result: JsonRpcResponse): string {
  return toolPayload(result).content[0]?.text ?? '';
}

test('TTLAB MCP endpoint exposes device, log, audit, and command tools over HTTP', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-mcp-e2e-'));
  const configFile = join(root, 'server.env');
  writeFileSync(configFile, `TTLAB_SERVER_PORT=${port}\nTTLAB_AGENT_ENABLED=1\nTTLAB_AGENT_TOKEN=secret-token\n`);
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_LOG_DIR: join(root, 'logs'), TTLAB_CONFIG_FILE: configFile, TTLAB_WEB_ROOT: process.cwd() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sockets: WebSocket[] = [];
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));

    // MCP endpoint requires authentication and POST
    const unauthenticated = await mcpCall(port, { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(unauthenticated.status, 401);
    const wrongToken = await mcpCall(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token');
    assert.equal(wrongToken.status, 401);
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/mcp/v1`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(wrongMethod.status, 405);

    // initialize handshake
    const initialize = await mcpCall(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh', version: '0.1' } } }, 'secret-token');
    assert.equal(initialize.status, 200);
    assert.equal((initialize.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
    const notification = await mcpCall(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'secret-token');
    assert.equal(notification.status, 202);

    // SSE framing is honored when the client requests it
    const sse = await mcpCall(port, { jsonrpc: '2.0', id: 2, method: 'ping' }, 'secret-token', 'text/event-stream');
    assert.ok(sse.contentType.startsWith('text/event-stream'));

    // tools/list
    const tools = await mcpCall(port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'secret-token');
    const names = ((tools.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).sort();
    assert.deepEqual(names, ['audit_query', 'client_list', 'client_update', 'command_execute', 'command_status', 'device_list', 'device_status', 'log_query']);

    // bring a client online so device commands and log streaming work
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/session`);
    sockets.push(socket);
    await once(socket, 'open');
    const syncPromise = waitForMessage(socket, (value) => value.type === 'sync.request');
    socket.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-mcp', platform: 'linux', architecture: 'amd64', capabilities: ['serial'] }, 'client-mcp')));
    await syncPromise;
    const serialPort = { deviceId: 'serial:mcp', path: '/dev/ttyMCP', stableIdentity: true, status: 'available' as const, portRole: 'control' as const, observedAt: new Date().toISOString() };
    const snapshot: ClientSnapshot = { snapshotRevision: 1, clientVersion: 'test', bootId: 'boot-mcp', health: 'healthy', devices: [serialPort], managedDevices: [{ deviceId: 'tvbox:mcp', deviceType: 'tv-stick-test-box', displayName: 'TV Stick Test Box', stableIdentity: 'tvbox-mcp', status: 'identified', ports: [serialPort], capabilities: ['serial-control'], observedAt: serialPort.observedAt }] };
    socket.send(JSON.stringify(message('client.snapshot', snapshot, 'client-mcp')));

    // client.list and device.list reflect the online client
    const clients = await callTool(port, 'client_list', {});
    assert.ok(textOf(clients).includes('client-mcp'));
    const devices = await callTool(port, 'device_list', {});
    assert.ok(textOf(devices).includes('tvbox:mcp'));

    // a persisted device log chunk is visible through log.query
    socket.send(JSON.stringify(message('device.log.chunk', { deviceId: 'tvbox:mcp', portId: 'serial:mcp-log', sequence: 11, capturedAt: new Date().toISOString(), data: 'hdmi error 0x2\\n', encoding: 'utf-8', truncated: false }, 'client-mcp')));
    await waitUntil(async () => {
      const result = await callTool(port, 'log_query', { types: ['device'], keyword: 'hdmi error' });
      return textOf(result).includes('hdmi error 0x2');
    });

    // low-risk command executes through the MCP endpoint and completes
    const executePromise = waitForMessage(socket, (value) => value.type === 'command.execute');
    const dispatch = await callTool(port, 'command_execute', { clientId: 'client-mcp', deviceId: 'tvbox:mcp', operation: 'system.ping', parameters: {} });
    assert.equal(toolPayload(dispatch).isError, false);
    const commandId = (JSON.parse(textOf(dispatch)) as { commandId: string }).commandId;
    const execute = await executePromise;
    assert.equal((execute.payload as { commandId: string }).commandId, commandId);
    socket.send(JSON.stringify(message('command.accepted', { commandId, deviceId: 'tvbox:mcp' }, 'client-mcp', execute.id)));
    socket.send(JSON.stringify(message('command.result', { commandId, deviceId: 'tvbox:mcp', success: true, output: 'PONG' }, 'client-mcp', execute.id)));
    await waitUntil(async () => {
      const status = await callTool(port, 'command_status', { commandId });
      return textOf(status).includes('"status":"result"');
    });

    // high-risk operations and updates dispatch; approval is enforced upstream
    // by the dsh approval gate, not by the MCP endpoint itself
    const reboot = await callTool(port, 'command_execute', { deviceId: 'tvbox:mcp', operation: 'device.reboot', parameters: { mode: 'NRM' } });
    assert.equal(toolPayload(reboot).isError, false);
    assert.ok(textOf(reboot).includes('"commandId"'));
    // updates now dispatch (release lookup); no release is uploaded in this test,
    // so the only failure is the missing release, not APPROVAL_REQUIRED
    const update = await callTool(port, 'client_update', { clientId: 'client-mcp', version: '1.1.0' });
    assert.equal(toolPayload(update).isError, true);
    assert.ok(textOf(update).includes('RELEASE_NOT_FOUND'));
    assert.ok(!textOf(update).includes('APPROVAL_REQUIRED'));

    // audit records the agent-originated dispatch
    await waitUntil(async () => {
      const audits = await callTool(port, 'audit_query', { keyword: 'command.dispatch' });
      return textOf(audits).includes('"actor":"agent"');
    });
  } finally {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP endpoint is disabled when agent integration is turned off', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-mcp-off-'));
  const configFile = join(root, 'server.env');
  writeFileSync(configFile, `TTLAB_SERVER_PORT=${port}\nTTLAB_AGENT_ENABLED=0\n`);
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_LOG_DIR: join(root, 'logs'), TTLAB_CONFIG_FILE: configFile, TTLAB_WEB_ROOT: process.cwd() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));
    const result = await mcpCall(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'any-token');
    assert.equal(result.status, 404);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
