import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalManager } from '../apps/server/src/agent-gateway/approvals.js';
import { ServerNativeEngine } from '../apps/server/src/agent-gateway/engine.js';
import type { LlmChatResult, LlmClient } from '../apps/server/src/agent-gateway/llm.js';
import { buildSystemPrompt, type AgentServerMessage } from '../apps/server/src/agent-gateway/types.js';
import type { AgentSink, AgentTurnContext } from '../apps/server/src/agent-gateway/engine.js';
import type { McpServerContext } from '../apps/server/src/mcp/index.js';

class FakeSink implements AgentSink {
  readonly messages: AgentServerMessage[] = [];

  send(message: AgentServerMessage): void {
    this.messages.push(message);
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

function fakeContext(sink: FakeSink, overrides: Partial<McpServerContext> = {}): { context: AgentTurnContext } {
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
  return { context: { sessionId: 'session-1', sink, mcpContext } };
}

test('system prompt reports only the configured model and forbids invented identity', () => {
  const prompt = buildSystemPrompt('deepseek-chat');
  assert.match(prompt, /Configured model: deepseek-chat/);
  assert.match(prompt, /never claim a specific vendor or model family that is not configured/);
  const bare = buildSystemPrompt();
  assert.ok(!bare.includes('Configured model'));
  assert.match(bare, /say you do not know/);
});

test('system prompt restricts scope to TTLAB and requires tool-based connectivity checks', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /test connectivity or communication/);
  assert.match(prompt, /verify it with a read-only tool/);
  assert.match(prompt, /outside that scope/);
  assert.match(prompt, /execute immediately and are recorded in the audit log/);
});

test('approval manager resolves responses and auto-rejects on timeout', async () => {
  const approvals = new ApprovalManager(50, () => undefined);
  const first = approvals.request('s1', 'command_execute', { operation: 'device.reboot' }, 'reboot');
  const second = approvals.request('s1', 'client_update', { version: '1.1.0' }, 'update');
  assert.equal(approvals.respond(first.approval.approvalId, 'approved'), true);
  assert.equal(await first.decision, 'approved');
  assert.equal(await second.decision, 'timeout');
});

test('approval manager rejects all pending approvals for a closed session', async () => {
  const approvals = new ApprovalManager(5_000, () => undefined);
  const handle = approvals.request('s1', 'command_execute', {}, 'x');
  approvals.rejectSession('s1');
  assert.equal(await handle.decision, 'rejected');
});

test('engine streams a plain text reply without tools', async () => {
  const sink = new FakeSink();
  const { context } = fakeContext(sink);
  const engine = new ServerNativeEngine({ llm: queuedLlm([{ content: '一切正常。' }]) });
  const messages = await engine.runTurn(context, [], '查一下状态');
  assert.equal(messages.filter((message) => message.role === 'user').length, 1);
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.delta' && message.delta === '一切正常。'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.done'));
});

test('engine keeps assistant replies in history so later turns retain context', async () => {
  const sink = new FakeSink();
  const { context } = fakeContext(sink);
  const engine = new ServerNativeEngine({ llm: queuedLlm([{ content: '第一轮回复。' }, { content: '第二轮回复。' }]) });
  const afterTurn1 = await engine.runTurn(context, [], '你好');
  const assistantReplies = afterTurn1.filter((message) => message.role === 'assistant' && message.toolCalls === undefined);
  assert.equal(assistantReplies.length, 1);
  assert.equal(assistantReplies[0]?.content, '第一轮回复。');
  const afterTurn2 = await engine.runTurn(context, afterTurn1, '再问一个');
  const allReplies = afterTurn2.filter((message) => message.role === 'assistant' && message.toolCalls === undefined);
  assert.ok(allReplies.some((message) => message.content === '第一轮回复。'));
  assert.ok(allReplies.some((message) => message.content === '第二轮回复。'));
});

test('engine runs a tool call and then replies with text', async () => {
  const sink = new FakeSink();
  const { context } = fakeContext(sink, {
    queryLogs: async () => ({ data: [{ ts: '2026-08-29T00:00:00.000Z', type: 'device', clientId: 'client-1', deviceId: 'tvbox:1', data: { sequence: 1, data: 'ok' } }], hasMore: false, nextOffset: 0, truncated: false }),
  });
  const engine = new ServerNativeEngine({
    llm: queuedLlm([
      { toolCalls: [{ id: 'call-1', name: 'log_query', arguments: { types: ['device'], keyword: 'error' } }] },
      { content: '未发现错误。' },
    ]),
  });
  await engine.runTurn(context, [], '查日志');
  assert.ok(sink.messages.some((message) => message.type === 'agent.tool.status' && message.tool === 'log_query' && message.toolStatus === 'done'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.delta' && message.delta === '未发现错误。'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.done'));
});

test('engine dispatches high-risk commands immediately without approval', async () => {
  const sink = new FakeSink();
  let dispatchedActor = '';
  const { context } = fakeContext(sink, {
    dispatchCommand: (input) => {
      dispatchedActor = input.actor;
      assert.equal(input.operation, 'device.reboot');
      return { ok: true, commandId: 'cmd-reboot' };
    },
  });
  const engine = new ServerNativeEngine({
    llm: queuedLlm([
      { toolCalls: [{ id: 'call-reboot', name: 'command_execute', arguments: { deviceId: 'tvbox:1', operation: 'device.reboot' } }] },
      { content: '重启已下发。' },
    ]),
  });
  await engine.runTurn(context, [], '重启设备');
  assert.equal(dispatchedActor, 'agent:session-1');
  assert.ok(!sink.messages.some((message) => message.type === 'agent.approval.request'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.tool.status' && message.tool === 'command_execute' && message.toolStatus === 'done'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.done'));
});

test('engine stops when the tool call loop exceeds the iteration limit', async () => {
  const sink = new FakeSink();
  const { context } = fakeContext(sink);
  const engine = new ServerNativeEngine({
    llm: { chat: async () => ({ toolCalls: [{ id: 'c', name: 'device_list', arguments: {} }] }) },
    maxIterations: 3,
  });
  await engine.runTurn(context, [], '循环');
  assert.ok(sink.messages.some((message) => message.type === 'agent.error' && message.code === 'AGENT_LOOP_LIMIT'));
  assert.ok(sink.messages.some((message) => message.type === 'agent.message.done'));
});
