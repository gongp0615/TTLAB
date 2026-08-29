import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function waitForAgentMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('agent websocket message timeout')), 5_000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(message)) { clearTimeout(timeout); socket.off('message', onMessage); resolve(message); }
    };
    socket.on('message', onMessage);
  });
}

function startFakeLlm(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk.toString(); });
      request.on('end', () => {
        const payload = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
        const messages = payload.messages ?? [];
        const last = messages[messages.length - 1];
        let choice: { message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> } };
        if (last?.role === 'tool') {
          const content = typeof last.content === 'string' ? last.content : '';
          if (content.includes('APPROVAL') || content.includes('dispatched') || content.includes('sequence')) {
            choice = { message: { role: 'assistant', content: '处理完毕。' } };
          } else {
            choice = { message: { role: 'assistant', content: '已执行工具。' } };
          }
        } else {
          const userContent = [...messages].reverse().find((item) => item.role === 'user')?.content ?? '';
          if (userContent.includes('重启')) {
            choice = { message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_reboot', type: 'function', function: { name: 'command.execute', arguments: JSON.stringify({ deviceId: 'tvbox:mcp', operation: 'device.reboot' }) } }] } };
          } else {
            choice = { message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_log', type: 'function', function: { name: 'log.query', arguments: JSON.stringify({ types: ['device'], keyword: 'error' }) } }] } };
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [choice] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

test('Agent gateway runs a full chat turn with tool calls, approvals, and audit', async () => {
  const llm = await startFakeLlm();
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-agent-e2e-'));
  const configFile = join(root, 'server.env');
  writeFileSync(configFile, [
    `TTLAB_SERVER_PORT=${port}`,
    'TTLAB_AGENT_ENABLED=1',
    'TTLAB_AGENT_TOKEN=secret-token',
    'TTLAB_AGENT_MODEL=deepseek-chat',
    `TTLAB_AGENT_LLM_URL=http://127.0.0.1:${llm.port}`,
    'TTLAB_DEEPSEEK_API_KEY=test-key',
    'TTLAB_AGENT_APPROVAL_TIMEOUT_MS=15000',
    '',
  ].join('\n'));
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TTLAB_SERVER_PORT: String(port),
      TTLAB_LOG_DIR: join(root, 'logs'),
      TTLAB_CONFIG_FILE: configFile,
      TTLAB_WEB_ROOT: process.cwd(),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sockets: WebSocket[] = [];
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));

    const clientSocket = new WebSocket(`ws://127.0.0.1:${port}/agent/v1/session`);
    sockets.push(clientSocket);
    await once(clientSocket, 'open');
    const syncPromise = waitForMessage(clientSocket, (value) => value.type === 'sync.request');
    clientSocket.send(JSON.stringify(message('client.hello', { clientVersion: 'test', protocolVersion: '1.0', bootId: 'boot-agent', platform: 'linux', architecture: 'amd64', capabilities: ['serial'] }, 'client-agent')));
    await syncPromise;
    const serialPort = { deviceId: 'serial:agent', path: '/dev/ttyAGENT', stableIdentity: true, status: 'available' as const, portRole: 'control' as const, observedAt: new Date().toISOString() };
    const snapshot: ClientSnapshot = { snapshotRevision: 1, clientVersion: 'test', bootId: 'boot-agent', health: 'healthy', devices: [serialPort], managedDevices: [{ deviceId: 'tvbox:mcp', deviceType: 'tv-stick-test-box', displayName: 'TV Stick Test Box', stableIdentity: 'tvbox-agent', status: 'identified', ports: [serialPort], capabilities: ['serial-control'], observedAt: serialPort.observedAt }] };
    clientSocket.send(JSON.stringify(message('client.snapshot', snapshot, 'client-agent')));

    const agentSocket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agent/session`);
    sockets.push(agentSocket);
    await once(agentSocket, 'open');
    const ready = await waitForAgentMessage(agentSocket, (message) => message.type === 'agent.session.ready');
    const sessionId = ready.sessionId as string;
    assert.equal(typeof sessionId, 'string');

    // turn 1: log.query tool call then a text reply
    agentSocket.send(JSON.stringify({ type: 'agent.message.submit', sessionId, content: '为什么 TVB-02 日志报错？' }));
    const logRunning = await waitForAgentMessage(agentSocket, (message) => message.type === 'agent.tool.status' && message.tool === 'log.query' && message.toolStatus === 'running');
    assert.ok(logRunning);
    await waitForAgentMessage(agentSocket, (message) => message.type === 'agent.tool.status' && message.tool === 'log.query' && message.toolStatus === 'done');
    const delta = await waitForAgentMessage(agentSocket, (message) => message.type === 'agent.message.delta');
    assert.equal(typeof delta.delta, 'string');
    await waitForAgentMessage(agentSocket, (message) => message.type === 'agent.message.done');

    // turn 2: high-risk reboot requires approval, then executes
    const rebootExecutePromise = waitForMessage(clientSocket, (value) => value.type === 'command.execute');
    agentSocket.send(JSON.stringify({ type: 'agent.message.submit', sessionId, content: '帮我重启设备' }));
    const approval = await waitForAgentMessage(agentSocket, (message) => message.type === 'agent.approval.request');
    assert.equal(approval.tool, 'command.execute');
    assert.equal((approval.args as { operation?: string }).operation, 'device.reboot');
    agentSocket.send(JSON.stringify({ type: 'agent.approval.response', sessionId, approvalId: approval.approvalId, decision: 'approved' }));
    const execute = await rebootExecutePromise;
    assert.equal((execute.payload as { operation?: string }).operation, 'device.reboot');
    await waitForAgentMessage(agentSocket, (message) => message.type === 'agent.message.done');

    // the agent-originated dispatch and approval decisions are audited
    const audit = await fetch(`http://127.0.0.1:${port}/api/v1/audit?keyword=command.dispatch`);
    const auditBody = await audit.json() as { data: Array<{ actor?: string; data: Record<string, unknown> }> };
    assert.ok(auditBody.data.some((entry) => typeof entry.actor === 'string' && entry.actor.startsWith('agent:') && entry.data.operation === 'device.reboot'));
    const approvalAudit = await fetch(`http://127.0.0.1:${port}/api/v1/audit?keyword=approval.decided`);
    const approvalBody = await approvalAudit.json() as { data: Array<{ data: Record<string, unknown> }> };
    assert.ok(approvalBody.data.some((entry) => entry.data.decision === 'approved'));
  } finally {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
    await llm.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Agent WebSocket endpoint is rejected when the agent is disabled', async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-agent-off-'));
  const configFile = join(root, 'server.env');
  writeFileSync(configFile, `TTLAB_SERVER_PORT=${port}\nTTLAB_AGENT_ENABLED=0\n`);
  const child = spawn(process.execPath, ['dist/apps/server/src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, TTLAB_SERVER_PORT: String(port), TTLAB_LOG_DIR: join(root, 'logs'), TTLAB_CONFIG_FILE: configFile, TTLAB_WEB_ROOT: process.cwd() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await waitForOutput(child, (line) => line.includes('server_started'));
    const failure = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agent/session`);
      socket.once('open', () => { socket.close(); resolve(false); });
      socket.once('error', () => resolve(true));
      socket.once('unexpected-response', () => resolve(true));
    });
    assert.equal(failure, true);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
