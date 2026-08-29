import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

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

function startFakeLlm(reply: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk.toString(); });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

test('Agent settings live in the config file and take effect at runtime', async () => {
  const llm1 = await startFakeLlm('来自 LLM1');
  const llm2 = await startFakeLlm('来自 LLM2');
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'ttlab-settings-e2e-'));
  const configFile = join(root, 'server.env');
  writeFileSync(configFile, [
    '# TTLAB test config',
    `TTLAB_SERVER_PORT=${port}`,
    'TTLAB_AGENT_ENABLED=1',
    'TTLAB_AGENT_MODEL=deepseek-chat',
    `TTLAB_AGENT_LLM_URL=http://127.0.0.1:${llm1.port}`,
    'TTLAB_AGENT_MAX_SESSIONS=8',
    'TTLAB_AGENT_APPROVAL_TIMEOUT_MS=60000',
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

    // initial settings reflect the config file
    const initial = await fetch(`http://127.0.0.1:${port}/api/v1/settings/agent`);
    assert.equal(initial.status, 200);
    const initialBody = await initial.json() as { data: Record<string, unknown> };
    assert.equal(initialBody.data.enabled, true);
    assert.equal(initialBody.data.model, 'deepseek-chat');
    assert.equal(initialBody.data.apiKeyConfigured, false);

    // a chat turn reaches the LLM endpoint from the config file
    const agent = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agent/session`);
    sockets.push(agent);
    await once(agent, 'open');
    const ready = await waitForAgentMessage(agent, (message) => message.type === 'agent.session.ready');
    agent.send(JSON.stringify({ type: 'agent.message.submit', sessionId: ready.sessionId, content: '你好' }));
    const firstDelta = await waitForAgentMessage(agent, (message) => message.type === 'agent.message.delta');
    assert.equal(firstDelta.delta, '来自 LLM1');

    // update the LLM URL through the settings API; it writes back to the config file
    const update = await fetch(`http://127.0.0.1:${port}/api/v1/settings/agent`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llmUrl: `http://127.0.0.1:${llm2.port}`, apiKey: 'new-secret' }),
    });
    assert.equal(update.status, 200);
    const updateBody = await update.json() as { data: { apiKeyConfigured: boolean } };
    assert.equal(updateBody.data.apiKeyConfigured, true);

    // the next turn reaches the new LLM endpoint without a restart
    agent.send(JSON.stringify({ type: 'agent.message.submit', sessionId: ready.sessionId, content: '再说一句' }));
    const secondDelta = await waitForAgentMessage(agent, (message) => message.type === 'agent.message.delta');
    assert.equal(secondDelta.delta, '来自 LLM2');

    // secrets are masked on read
    const after = await fetch(`http://127.0.0.1:${port}/api/v1/settings/agent`);
    const afterBody = await after.json() as { data: Record<string, unknown> };
    assert.equal(afterBody.data.apiKeyConfigured, true);
    assert.equal('apiKey' in afterBody.data, false);

    // invalid settings are rejected with a validation error
    const invalid = await fetch(`http://127.0.0.1:${port}/api/v1/settings/agent`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxSessions: 0 }),
    });
    assert.equal(invalid.status, 400);

    // disabling the agent turns off the MCP endpoint and rejects new chat sessions
    const disable = await fetch(`http://127.0.0.1:${port}/api/v1/settings/agent`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disable.status, 200);
    const mcp = await fetch(`http://127.0.0.1:${port}/mcp/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(mcp.status, 404);
    const rejected = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agent/session`);
      socket.once('open', () => { socket.close(); resolve(false); });
      socket.once('error', () => resolve(true));
      socket.once('unexpected-response', () => resolve(true));
    });
    assert.equal(rejected, true);

    // the config file holds the updated values in server.env format
    const persisted = readFileSync(configFile, 'utf8');
    assert.ok(persisted.includes('TTLAB_AGENT_ENABLED=0'));
    assert.ok(persisted.includes(`TTLAB_AGENT_LLM_URL=http://127.0.0.1:${llm2.port}`));
    assert.ok(persisted.includes('TTLAB_DEEPSEEK_API_KEY=new-secret'));
    assert.ok(persisted.includes(`TTLAB_SERVER_PORT=${port}`));
  } finally {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
    await llm1.close();
    await llm2.close();
    rmSync(root, { recursive: true, force: true });
  }
});
