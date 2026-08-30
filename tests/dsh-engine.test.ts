import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import test from 'node:test';
import { ApprovalManager } from '../apps/server/src/agent-gateway/approvals.js';
import { DshEngine } from '../apps/server/src/agent-gateway/dsh-engine.js';
import { AgentGateway } from '../apps/server/src/agent-gateway/gateway.js';
import type { AgentSink } from '../apps/server/src/agent-gateway/engine.js';
import type { AgentServerMessage } from '../apps/server/src/agent-gateway/types.js';
import type { AgentEngineOpenContext } from '../apps/server/src/agent-gateway/engine-adapter.js';
import type { McpServerContext } from '../apps/server/src/mcp/index.js';

class FakeSink implements AgentSink {
  readonly messages: AgentServerMessage[] = [];
  private waiters: Array<{ predicate: (message: AgentServerMessage) => boolean; resolve: (message: AgentServerMessage) => void }> = [];

  send(message: AgentServerMessage): void {
    this.messages.push(message);
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(message);
      }
    }
  }

  waitFor(predicate: (message: AgentServerMessage) => boolean): Promise<AgentServerMessage> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timeout')), 3_000);
      this.waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  }
}

function fakeContext(sink: FakeSink, approvals: ApprovalManager): { context: AgentEngineOpenContext } {
  const mcpContext: McpServerContext = {
    serverName: 'ttlab',
    serverVersion: 'test',
    listClients: () => [],
    listDevices: () => [],
    getDeviceStatus: () => undefined,
    queryLogs: async () => ({ data: [], hasMore: false, nextOffset: 0, truncated: false }),
    queryAudit: async () => ({ data: [], hasMore: false, nextOffset: 0, truncated: false }),
    getCommandStatus: () => undefined,
    dispatchCommand: () => ({ ok: false as const, error: { code: 'CLIENT_OFFLINE', message: 'offline', retryable: true } }),
    dispatchUpdate: () => ({ ok: false as const, error: { code: 'CLIENT_OFFLINE', message: 'offline', retryable: true } }),
  };
  return { context: { webSessionId: 'session-1', sink, approvals, mcpContext, auditApproval: () => undefined } };
}

interface MockDsh {
  port: number;
  createdSessions: Array<Record<string, unknown>>;
  prompts: Array<Record<string, unknown>>;
  responds: Array<Record<string, unknown>>;
  sseReady: Promise<void>;
  sendFrame(frame: Record<string, unknown>): void;
  close(): Promise<void>;
}

function startMockDsh(): Promise<MockDsh> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ noServer: true });
    let currentWs: WebSocket | null = null;
    let sseResolve: () => void = () => undefined;
    const sseReady = new Promise<void>((done) => { sseResolve = done; });
    const createdSessions: Array<Record<string, unknown>> = [];
    const prompts: Array<Record<string, unknown>> = [];
    const responds: Array<Record<string, unknown>> = [];
    const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/respond' && request.method === 'POST') {
        let body = '';
        request.on('data', (chunk) => { body += chunk.toString(); });
        request.on('end', () => {
          responds.push(JSON.parse(body) as Record<string, unknown>);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      if (url.pathname.startsWith('/api/') && request.method === 'POST') {
        let body = '';
        request.on('data', (chunk) => { body += chunk.toString(); });
        request.on('end', () => {
          const message = JSON.parse(body) as { rpcId?: string; method?: string; payload?: Record<string, unknown> };
          const method = message.method ?? '';
          if (method === 'session.create') createdSessions.push(message.payload ?? {});
          if (method === 'session.prompt') prompts.push(message.payload ?? {});
          response.writeHead(200, { 'content-type': 'application/json' });
          const value = method === 'session.create' ? { sessionId: (message.payload as { sessionId?: string })?.sessionId } : { accepted: true };
          response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/events.mux') {
        wss.handleUpgrade(request, socket, head, (websocket) => {
          currentWs = websocket;
          sseResolve();
        });
        return;
      }
      socket.destroy();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        createdSessions,
        prompts,
        responds,
        sseReady,
        sendFrame: (frame) => {
          if (currentWs !== null && currentWs.readyState === WebSocket.OPEN) currentWs.send(JSON.stringify(frame));
        },
        close: () => new Promise<void>((done) => {
          if (currentWs !== null) currentWs.close();
          wss.close();
          server.close(() => done());
        }),
      });
    });
  });
}

test('dsh engine opens a dsh session (ttlab:<webId>) and submits prompts', async () => {
  const mock = await startMockDsh();
  try {
    const sink = new FakeSink();
    const approvals = new ApprovalManager(5_000, () => undefined);
    const { context } = fakeContext(sink, approvals);
    const engine = new DshEngine({ baseUrl: `http://127.0.0.1:${mock.port}`, workdir: '/tmp/agent-work', approvalTimeoutMs: 60_000 });
    await engine.openSession(context);
    assert.equal(mock.createdSessions.length, 1);
    assert.equal(mock.createdSessions[0]?.sessionId, 'ttlab:session-1');
    assert.equal(mock.createdSessions[0]?.cwd, '/tmp/agent-work');
    await engine.submit('session-1', 'hello');
    assert.equal(mock.prompts[0]?.mode, 'queue');
    assert.deepEqual(mock.prompts[0]?.content, [{ type: 'text', text: 'hello' }]);
    await engine.closeSession('session-1');
  } finally {
    await mock.close();
  }
});

test('dsh engine translates session events to gateway messages', async () => {
  const mock = await startMockDsh();
  try {
    const sink = new FakeSink();
    const approvals = new ApprovalManager(5_000, () => undefined);
    const { context } = fakeContext(sink, approvals);
    const engine = new DshEngine({ baseUrl: `http://127.0.0.1:${mock.port}`, workdir: '/tmp/w', approvalTimeoutMs: 60_000 });
    await engine.openSession(context);
    await mock.sseReady;

    mock.sendFrame({ type: 'server-request', rpcId: 'f1', method: 'session/event', payload: { sessionId: 'ttlab:session-1', event: { type: 'turn/start', data: {} } } });
    mock.sendFrame({ type: 'server-request', rpcId: 'f2', method: 'session/event', payload: { sessionId: 'ttlab:session-1', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好' }] } } } } });
    mock.sendFrame({ type: 'server-request', rpcId: 'f3', method: 'session/event', payload: { sessionId: 'ttlab:session-1', event: { type: 'tool/call', data: { callId: 'c1', name: 'client_list', arguments: '{}' } } } });
    mock.sendFrame({ type: 'server-request', rpcId: 'f4', method: 'session/event', payload: { sessionId: 'ttlab:session-1', event: { type: 'tool/result', data: { callId: 'c1', message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[]' }] }] } } } } });
    mock.sendFrame({ type: 'server-request', rpcId: 'f5', method: 'session/event', payload: { sessionId: 'ttlab:session-1', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });

    const delta = await sink.waitFor((message) => message.type === 'agent.message.delta');
    assert.equal(delta.delta, '你好');
    const running = await sink.waitFor((message) => message.type === 'agent.tool.status' && message.toolStatus === 'running');
    assert.equal(running.tool, 'client_list');
    const doneTool = await sink.waitFor((message) => message.type === 'agent.tool.status' && message.toolStatus === 'done');
    assert.equal(doneTool.result?.text, '[]');
    await sink.waitFor((message) => message.type === 'agent.message.done');
    await engine.closeSession('session-1');
  } finally {
    await mock.close();
  }
});

test('dsh engine forwards native approvals and resolves them via /api/respond', async () => {
  const mock = await startMockDsh();
  try {
    const sink = new FakeSink();
    const approvals = new ApprovalManager(5_000, () => undefined);
    const { context } = fakeContext(sink, approvals);
    const engine = new DshEngine({ baseUrl: `http://127.0.0.1:${mock.port}`, workdir: '/tmp/w', approvalTimeoutMs: 60_000 });
    await engine.openSession(context);
    await mock.sseReady;

    mock.sendFrame({ type: 'server-request', rpcId: 'apr-rpc-1', method: 'approval/requested', payload: { type: 'approval/requested', sessionId: 'ttlab:session-1', approvalId: 'aprv-1', toolName: 'command_execute', callId: 'call-reboot', reason: 'reboot' } });
    const request = await sink.waitFor((message) => message.type === 'agent.approval.request');
    assert.equal(request.approvalId, 'apr-rpc-1');
    assert.equal(request.tool, 'command_execute');
    assert.equal(request.reason, 'reboot');
    assert.equal(typeof request.expiresAt, 'string');

    await engine.respondApproval('session-1', 'apr-rpc-1', 'approved');
    assert.equal(mock.responds.length, 1);
    const envelope = mock.responds[0] as { rpcId?: string; result?: { value?: Record<string, unknown> } };
    assert.equal(envelope.rpcId, 'apr-rpc-1');
    assert.equal((envelope.result?.value as { outcome?: string }).outcome, 'allowed-once');
    assert.equal((envelope.result?.value as { approvalId?: string }).approvalId, 'aprv-1');
    await engine.closeSession('session-1');
  } finally {
    await mock.close();
  }
});

test('dsh engine answers ask_user_question approvals (approve selects affirmative, reject cancels)', async () => {
  const mock = await startMockDsh();
  try {
    const sink = new FakeSink();
    const approvals = new ApprovalManager(5_000, () => undefined);
    const { context } = fakeContext(sink, approvals);
    const engine = new DshEngine({ baseUrl: `http://127.0.0.1:${mock.port}`, workdir: '/tmp/w', approvalTimeoutMs: 60_000 });
    await engine.openSession(context);
    await mock.sseReady;

    mock.sendFrame({ type: 'server-request', rpcId: 'q-rpc-1', method: 'question/requested', payload: { type: 'question/requested', sessionId: 'ttlab:session-1', questions: [{ id: 'q1', question: '允许重启吗？', options: [{ label: '是，批准' }, { label: '否' }] }] } });
    const request = await sink.waitFor((message) => message.type === 'agent.approval.request');
    assert.equal(request.tool, 'ask_user_question');
    assert.equal(request.reason, '允许重启吗？');

    await engine.respondApproval('session-1', 'q-rpc-1', 'approved');
    const approveEnvelope = mock.responds[0]! as { rpcId?: string; result?: { value?: { answer?: { answers?: Array<{ id: string; selected: string[] }> } } } };
    assert.equal(approveEnvelope.rpcId, 'q-rpc-1');
    // dsh validates `selected` against the option LABELS (options may carry no id)
    assert.deepEqual(approveEnvelope.result?.value?.answer?.answers?.[0]?.selected, ['是，批准']);

    mock.sendFrame({ type: 'server-request', rpcId: 'q-rpc-2', method: 'question/requested', payload: { type: 'question/requested', sessionId: 'ttlab:session-1', questions: [{ id: 'q2', question: '继续吗？', options: [{ id: 'no', label: 'No' }] }] } });
    await sink.waitFor((message) => message.type === 'agent.approval.request' && message.approvalId === 'q-rpc-2');
    await engine.respondApproval('session-1', 'q-rpc-2', 'rejected');
    const rejectEnvelope = mock.responds[1]! as { rpcId?: string; result?: { ok?: boolean; error?: { code?: string } } };
    assert.equal(rejectEnvelope.rpcId, 'q-rpc-2');
    assert.equal(rejectEnvelope.result?.ok, false);
    assert.equal(rejectEnvelope.result?.error?.code, 'cancelled');
    await engine.closeSession('session-1');
  } finally {
    await mock.close();
  }
});

function makeWebSocketWaiter(socket: WebSocket): (predicate: (message: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{ predicate: (message: Record<string, unknown>) => boolean; resolve: (message: Record<string, unknown>) => void }> = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  return (predicate) => {
    const existing = messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent websocket message timeout')), 3_000);
      waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };
}

test('gateway drives a full dsh chat turn over the web socket', async () => {
  const mock = await startMockDsh();
  const approvals = new ApprovalManager(60_000, () => undefined);
  const engine = new DshEngine({ baseUrl: `http://127.0.0.1:${mock.port}`, workdir: '/tmp/w', approvalTimeoutMs: 60_000 });
  const wss = new WebSocketServer({ port: 0 });
  const gateway = new AgentGateway({
    engine,
    approvals,
    mcpContext: {
      serverName: 'ttlab',
      serverVersion: 'test',
      listClients: () => [],
      listDevices: () => [],
      getDeviceStatus: () => undefined,
      queryLogs: async () => ({ data: [], hasMore: false, nextOffset: 0, truncated: false }),
      queryAudit: async () => ({ data: [], hasMore: false, nextOffset: 0, truncated: false }),
      getCommandStatus: () => undefined,
      dispatchCommand: () => ({ ok: false as const, error: { code: 'CLIENT_OFFLINE', message: 'offline', retryable: true } }),
      dispatchUpdate: () => ({ ok: false as const, error: { code: 'CLIENT_OFFLINE', message: 'offline', retryable: true } }),
    },
    maxSessions: 8,
    logAgent: () => undefined,
    auditApproval: () => undefined,
  });
  gateway.attachServer(wss);
  const address = wss.address() as { port: number };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/agent/session`);
  const waitFor = makeWebSocketWaiter(socket);
  await once(socket, 'open');
  try {
    await waitFor((message) => message.type === 'agent.session.ready');
    socket.send(JSON.stringify({ type: 'agent.session.open', sessionId: 'win-abc' }));
    socket.send(JSON.stringify({ type: 'agent.message.submit', content: '查一下状态' }));
    await mock.sseReady;

    // the dsh session is created with the window-stable id
    mock.sendFrame({ type: 'server-request', rpcId: 'g0', method: 'session/event', payload: { sessionId: 'ttlab:win-abc', event: { type: 'tool/call', data: { callId: 'c1', name: 'client_list', arguments: '{}' } } } });
    await waitFor((message) => message.type === 'agent.tool.status' && message.toolStatus === 'running');
    mock.sendFrame({ type: 'server-request', rpcId: 'g1', method: 'session/event', payload: { sessionId: 'ttlab:win-abc', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '全部正常。' }] } } } } });
    mock.sendFrame({ type: 'server-request', rpcId: 'g2', method: 'session/event', payload: { sessionId: 'ttlab:win-abc', event: { type: 'tool/result', data: { callId: 'c1', message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[]' }] }] } } } } });
    mock.sendFrame({ type: 'server-request', rpcId: 'g3', method: 'session/event', payload: { sessionId: 'ttlab:win-abc', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });

    const delta = await waitFor((message) => message.type === 'agent.message.delta');
    assert.equal(delta.delta, '全部正常。');
    await waitFor((message) => message.type === 'agent.message.done');
    assert.equal(mock.createdSessions[0]?.sessionId, 'ttlab:win-abc');
  } finally {
    socket.close();
    gateway.close();
    await new Promise<void>((done) => wss.close(() => done()));
    await mock.close();
  }
});
