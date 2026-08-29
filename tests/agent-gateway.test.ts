import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalManager } from '../apps/server/src/agent-gateway/approvals.js';
import { ServerNativeEngine } from '../apps/server/src/agent-gateway/engine.js';
import type { LlmChatResult, LlmClient } from '../apps/server/src/agent-gateway/llm.js';
import type { AgentServerMessage } from '../apps/server/src/agent-gateway/types.js';
import type { AgentSink, AgentTurnContext } from '../apps/server/src/agent-gateway/engine.js';
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

function queuedLlm(results: Array<LlmChatResult>): LlmClient {
  let index = 0;
  return { chat: async () => {
    const result = results[index] ?? { content: 'finish' };
    index += 1;
    return result;
  } };
}

function fakeContext(sink: FakeSink, approvals: ApprovalManager, overrides: Partial<McpServerContext> = {}): { context: AgentTurnContext } {
  const base: McpServerContext = {
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
  const mcpContext: McpServerContext = { ...base, ...overrides };
  return { context: { sessionId: 'session-1', sink, approvals, mcpContext, auditApproval: () => undefined } };
}

test('approval manager resolves responses and auto-rejects on timeout', async () => {
  const approvals = new ApprovalManager(50, () => undefined);
  const first = approvals.request('s1', 'command.execute', { operation: 'device.reboot' }, 'reboot');
  const second = approvals.request('s1', 'client.update', { version: '1.1.0' }, 'update');
  assert.equal(approvals.respond(first.approval.approvalId, 'approved'), true);
  assert.equal(await first.decision, 'approved');
  assert.equal(await second.decision, 'timeout');
});

test('approval manager rejects all pending approvals for a closed session', async () => {
  const approvals = new ApprovalManager(5_000, () => undefined);
  const handle = approvals.request('s1', 'command.execute', {}, 'x');
  approvals.rejectSession('s1');
  assert.equal(await handle.decision, 'rejected');
});

test('engine streams a plain text reply without tools', async () => {
  const sink = new FakeSink();
  const approvals = new ApprovalManager(5_000, () => undefined);
  const { context } = fakeContext(sink, approvals);
  const engine = new ServerNativeEngine({ llm: queuedLlm([{ content: '一切正常。' }]) });
  const messages = await engine.runTurn(context, [], '查一下状态');
  assert.equal(messages.filter((message) => message.role === 'user').length, 1);
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.delta' && message.delta === '一切正常。'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.done'));
});

test('engine runs a tool call and then replies with text', async () => {
  const sink = new FakeSink();
  const approvals = new ApprovalManager(5_000, () => undefined);
  const { context } = fakeContext(sink, approvals, {
    queryLogs: async () => ({ data: [{ ts: '2026-08-29T00:00:00.000Z', type: 'device', clientId: 'client-1', deviceId: 'tvbox:1', data: { sequence: 1, data: 'ok' } }], hasMore: false, nextOffset: 0, truncated: false }),
  });
  const engine = new ServerNativeEngine({
    llm: queuedLlm([
      { toolCalls: [{ id: 'call-1', name: 'log.query', arguments: { types: ['device'], keyword: 'error' } }] },
      { content: '未发现错误。' },
    ]),
  });
  await engine.runTurn(context, [], '查日志');
  assert.ok(sink.messages.some((message) => message.type === 'agent.tool.status' && message.tool === 'log.query' && message.toolStatus === 'done'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.delta' && message.delta === '未发现错误。'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.done'));
});

test('engine requests approval for high-risk commands and dispatches after approval', async () => {
  const sink = new FakeSink();
  const approvals = new ApprovalManager(5_000, () => undefined);
  let dispatchedActor = '';
  const { context } = fakeContext(sink, approvals, {
    dispatchCommand: (input) => {
      dispatchedActor = input.actor;
      assert.equal(input.operation, 'device.reboot');
      return { ok: true, commandId: 'cmd-reboot' };
    },
  });
  const engine = new ServerNativeEngine({
    llm: queuedLlm([
      { toolCalls: [{ id: 'call-reboot', name: 'command.execute', arguments: { deviceId: 'tvbox:1', operation: 'device.reboot' } }] },
      { content: '重启已下发。' },
    ]),
  });
  const turn = engine.runTurn(context, [], '重启设备');
  const approval = await sink.waitFor((message) => message.type === 'agent.approval.request');
  assert.equal(approval.tool, 'command.execute');
  approvals.respond(approval.approvalId as string, 'approved');
  await turn;
  assert.equal(dispatchedActor, 'agent:session-1');
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.done'));
});

test('engine reports rejection when the operator declines a high-risk command', async () => {
  const sink = new FakeSink();
  const approvals = new ApprovalManager(5_000, () => undefined);
  let dispatched = false;
  const { context } = fakeContext(sink, approvals, {
    dispatchCommand: () => { dispatched = true; return { ok: true, commandId: 'cmd-x' }; },
  });
  const engine = new ServerNativeEngine({
    llm: queuedLlm([
      { toolCalls: [{ id: 'call-x', name: 'command.execute', arguments: { deviceId: 'tvbox:1', operation: 'device.reboot' } }] },
      { content: '已取消。' },
    ]),
  });
  const turn = engine.runTurn(context, [], '重启');
  const approval = await sink.waitFor((message) => message.type === 'agent.approval.request');
  approvals.respond(approval.approvalId as string, 'rejected');
  await turn;
  assert.equal(dispatched, false);
  const toolError = sink.messages.find((message) => message.type === 'agent.tool.status' && message.toolStatus === 'error');
  assert.ok(toolError?.result?.text.includes('APPROVAL_REJECTED'));
});

test('engine times out pending approvals and adapts', async () => {
  const sink = new FakeSink();
  const approvals = new ApprovalManager(30, () => undefined);
  let dispatched = false;
  const { context } = fakeContext(sink, approvals, {
    dispatchCommand: () => { dispatched = true; return { ok: true, commandId: 'cmd-x' }; },
  });
  const engine = new ServerNativeEngine({
    llm: queuedLlm([
      { toolCalls: [{ id: 'call-x', name: 'command.execute', arguments: { deviceId: 'tvbox:1', operation: 'device.reboot' } }] },
      { content: '审批超时，已取消。' },
    ]),
  });
  await engine.runTurn(context, [], '重启');
  assert.equal(dispatched, false);
  assert.ok(sink.messages.some((message) => message.type === 'agent.tool.status' && message.toolStatus === 'error' && message.result?.text.includes('APPROVAL_TIMEOUT')));
});

test('engine stops when the tool call loop exceeds the iteration limit', async () => {
  const sink = new FakeSink();
  const approvals = new ApprovalManager(5_000, () => undefined);
  const { context } = fakeContext(sink, approvals);
  const engine = new ServerNativeEngine({
    llm: { chat: async () => ({ toolCalls: [{ id: 'c', name: 'device.list', arguments: {} }] }) },
    maxIterations: 3,
  });
  await engine.runTurn(context, [], '循环');
  assert.ok(sink.messages.some((message) => message.type === 'agent.error' && message.code === 'AGENT_LOOP_LIMIT'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.done'));
});
