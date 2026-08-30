import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import WebSocket from 'ws';
import type { AgentSink } from './engine.js';
import type { AgentEngine, AgentEngineOpenContext } from './engine-adapter.js';

/**
 * DeepSeek Harness (dsh) engine.
 *
 * The web chat panel is mapped 1:1 to a dsh session running inside the `dsh
 * web` app. The gateway acts as an HTTP client of dsh's local API:
 *
 * - `POST /api/session.create` with a deterministic sessionId
 *   (`ttlab:<webSessionId>`) — calling again with the same id resumes the
 *   same dsh session, so all subsequent messages in a web window stay on one
 *   dsh session.
 * - `POST /api/session.prompt` submits user text (queue mode).
 * - `GET /api/events.mux` streams session events (assistant text, tool calls,
 *   approvals/questions) which are translated to the gateway protocol.
 * - `POST /api/respond` resolves pending approvals/questions.
 *
 * Context management, the model loop, and tool calling are entirely owned by
 * dsh; this engine only forwards events and decisions.
 */
export interface DshEngineOptions {
  baseUrl: string | (() => string);
  token?: string | (() => string | undefined);
  workdir: string | (() => string);
  approvalTimeoutMs: number | (() => number);
}

interface DshQuestion {
  id: string;
  question: string;
  options?: Array<{ id?: string; label?: string; description?: string }>;
  multiSelect?: boolean;
}

interface PendingApproval {
  kind: 'approval';
  rpcId: string;
  approvalId: string;
  sessionId: string;
}

interface PendingQuestion {
  kind: 'question';
  rpcId: string;
  sessionId: string;
  questions: DshQuestion[];
}

interface DshSessionState {
  webSessionId: string;
  dshSessionId: string;
  sink: AgentSink;
  auditApproval: AgentEngineOpenContext['auditApproval'];
  controller: AbortController;
  subscription: Promise<void>;
  pending: Map<string, PendingApproval | PendingQuestion>;
  turnActive: boolean;
  closing: boolean;
}

const AFFIRMATIVE_WORDS = ['yes', 'approve', 'allow', 'ok', 'confirm', '是', '确认', '同意', '批准', '允许'];

function resolveString(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value;
}

function resolveOptional(value: string | (() => string | undefined) | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'function' ? value() : value;
}

function resolveNumber(value: number | (() => number)): number {
  return typeof value === 'function' ? value() : value;
}

function extractText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DshEngine implements AgentEngine {
  readonly kind = 'dsh' as const;
  private readonly states = new Map<string, DshSessionState>();

  constructor(private readonly options: DshEngineOptions) {}

  async openSession(context: AgentEngineOpenContext): Promise<void> {
    const existing = this.states.get(context.webSessionId);
    if (existing !== undefined) {
      existing.closing = true;
      existing.controller.abort();
    }
    const dshSessionId = `ttlab:${context.webSessionId}`;
    const workdir = resolveString(this.options.workdir);
    const created = await this.callUnary('session.create', {
      sessionId: dshSessionId,
      cwd: isAbsolute(workdir) ? workdir : resolve(workdir),
    });
    if (!created.ok) throw new Error(`dsh session.create failed: ${JSON.stringify(created.error)}`);
    const resolvedSessionId = (created.value as { sessionId?: string })?.sessionId ?? dshSessionId;
    const state: DshSessionState = {
      webSessionId: context.webSessionId,
      dshSessionId: resolvedSessionId,
      sink: context.sink,
      auditApproval: context.auditApproval,
      controller: new AbortController(),
      subscription: Promise.resolve(),
      pending: new Map(),
      turnActive: false,
      closing: false,
    };
    state.subscription = this.subscribeEvents(state);
    this.states.set(context.webSessionId, state);
  }

  async submit(webSessionId: string, content: string): Promise<void> {
    const state = this.states.get(webSessionId);
    if (state === undefined) throw new Error(`dsh session not open: ${webSessionId}`);
    const result = await this.callUnary('session.prompt', {
      sessionId: state.dshSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: content }],
    });
    if (!result.ok) throw new Error(`dsh session.prompt failed: ${JSON.stringify(result.error)}`);
    if ((result.value as { accepted?: boolean })?.accepted !== true) throw new Error('dsh did not accept the prompt');
    state.turnActive = true;
  }

  async respondApproval(webSessionId: string, approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const state = this.states.get(webSessionId);
    if (state === undefined) return;
    const pending = state.pending.get(approvalId);
    if (pending === undefined) return;
    try {
      if (pending.kind === 'approval') {
        await this.postRespond(approvalId, {
          ok: true,
          value: {
            approvalId: pending.approvalId,
            sessionId: pending.sessionId,
            outcome: decision === 'approved' ? 'allowed-once' : 'rejected',
          },
        });
        state.auditApproval(approvalId, 'dsh-tool-approval', decision, { approvalId: pending.approvalId });
      } else if (decision === 'approved') {
        const answers = pending.questions.map((question) => {
          const selected = this.affirmativeOption(question);
          return selected.length > 0 ? { id: question.id, selected } : { id: question.id, selected: [], custom: 'yes' };
        });
        await this.postRespond(approvalId, {
          ok: true,
          value: { sessionId: pending.sessionId, answer: { answers } },
        });
        state.auditApproval(approvalId, 'ask_user_question', decision, { questions: pending.questions });
      } else {
        await this.postRespond(approvalId, { ok: false, error: { code: 'cancelled' } });
        state.auditApproval(approvalId, 'ask_user_question', decision, { questions: pending.questions });
      }
    } finally {
      state.pending.delete(approvalId);
    }
  }

  async closeSession(webSessionId: string): Promise<void> {
    const state = this.states.get(webSessionId);
    if (state === undefined) return;
    state.closing = true;
    state.controller.abort();
    // Only tear down if this is still the current state; a window reconnect
    // may have opened a fresh state for the same key in the meantime.
    if (this.states.get(webSessionId) === state) this.states.delete(webSessionId);
  }

  private affirmativeOption(question: DshQuestion): string[] {
    const options = question.options ?? [];
    if (options.length === 0) return [];
    const labelOf = (option: { id?: string; label?: string }): string => option.label ?? option.id ?? '';
    const affirmative = options.find((option) => {
      const label = labelOf(option).toLowerCase();
      return AFFIRMATIVE_WORDS.some((word) => label.includes(word.toLowerCase()));
    });
    const chosen = affirmative ?? options[0];
    return chosen !== undefined ? [labelOf(chosen)] : [];
  }

  private async subscribeEvents(state: DshSessionState): Promise<void> {
    while (!state.closing) {
      try {
        await this.readMuxOnce(state);
      } catch (error) {
        if (state.closing) return;
        state.sink.send({ type: 'agent.error', sessionId: state.webSessionId, code: 'DSH_STREAM_ERROR', message: error instanceof Error ? error.message : 'dsh event stream lost' });
        if (state.turnActive) {
          state.turnActive = false;
          state.sink.send({ type: 'agent.message.done', sessionId: state.webSessionId });
        }
      }
      if (state.closing) return;
      await delay(2_000);
    }
  }

  private async readMuxOnce(state: DshSessionState): Promise<void> {
    const baseUrl = resolveString(this.options.baseUrl).replace(/\/+$/, '');
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/events.mux`;
    const token = resolveOptional(this.options.token);
    const socket = new WebSocket(wsUrl, {
      headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
      signal: state.controller.signal,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          socket.off('message', onMessage);
          socket.off('error', onError);
          socket.off('close', onClose);
          if (error !== undefined) reject(error);
          else resolve();
        };
        const onMessage = (data: WebSocket.RawData) => {
          try {
            this.handleFrame(state, data.toString());
          } catch {
            // one malformed frame must not kill the stream
          }
        };
        const onError = (error: Error) => settle(error);
        const onClose = () => settle();
        socket.on('message', onMessage);
        socket.on('error', onError);
        socket.on('close', onClose);
      });
    } finally {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
  }

  private handleFrame(state: DshSessionState, json: string): void {
    const line = json.trim();
    if (line.startsWith('data:')) {
      // tolerate the SSE-wrapped form; the dsh downlink sends plain JSON
      const payload = line.slice(5).trim();
      if (payload === '') return;
      this.handleFrame(state, payload);
      return;
    }
    if (line === '') return;
    let frame: { rpcId?: string; method?: string; payload?: Record<string, unknown> };
    try {
      frame = JSON.parse(line) as { rpcId?: string; method?: string; payload?: Record<string, unknown> };
    } catch {
      return;
    }
    const method = frame.method;
    const payload = frame.payload ?? {};
    if (method === 'session/event') {
      const event = payload.event as { type?: string; data?: Record<string, unknown> } | undefined;
      if (event !== undefined) this.handleSessionEvent(state, event);
    } else if (method === 'approval/requested') {
      this.handleApprovalRequested(state, frame.rpcId ?? '', payload);
    } else if (method === 'question/requested') {
      this.handleQuestionRequested(state, frame.rpcId ?? '', payload);
    }
  }

  private handleSessionEvent(state: DshSessionState, event: { type?: string; data?: Record<string, unknown> }): void {
    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start':
        state.turnActive = true;
        state.sink.send({ type: 'agent.session.status', sessionId: state.webSessionId, status: 'thinking' });
        break;
      case 'assistant/message': {
        const message = data.message as { content?: unknown } | undefined;
        const text = extractText(message?.content);
        if (text !== '') state.sink.send({ type: 'agent.message.delta', sessionId: state.webSessionId, delta: text });
        break;
      }
      case 'tool/call': {
        let args: Record<string, unknown> = {};
        if (typeof data.arguments === 'string') {
          try {
            args = JSON.parse(data.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }
        }
        state.sink.send({ type: 'agent.tool.status', sessionId: state.webSessionId, tool: String(data.name ?? 'tool'), toolStatus: 'running', args });
        break;
      }
      case 'tool/result': {
        const message = data.message as { content?: Array<{ type?: string; content?: unknown; isError?: boolean }> } | undefined;
        const block = message?.content?.[0];
        const text = extractText(block?.content);
        const isError = block?.isError === true || data.error !== undefined;
        state.sink.send({ type: 'agent.tool.status', sessionId: state.webSessionId, tool: '', toolStatus: isError ? 'error' : 'done', result: { text, isError } });
        break;
      }
      case 'turn/end': {
        state.turnActive = false;
        const reason = data.reason as { kind?: string; error?: { code?: string; message?: string } } | undefined;
        if (reason?.kind === 'error') {
          state.sink.send({ type: 'agent.error', sessionId: state.webSessionId, code: 'DSH_TURN_ERROR', message: reason.error?.message ?? 'agent turn failed' });
        }
        state.sink.send({ type: 'agent.message.done', sessionId: state.webSessionId });
        break;
      }
      default:
        break;
    }
  }

  private handleApprovalRequested(state: DshSessionState, rpcId: string, payload: Record<string, unknown>): void {
    const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : state.dshSessionId;
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool';
    state.pending.set(rpcId, { kind: 'approval', rpcId, approvalId, sessionId });
    state.sink.send({
      type: 'agent.approval.request',
      sessionId: state.webSessionId,
      approvalId: rpcId,
      tool: toolName,
      args: typeof payload.callId === 'string' ? { callId: payload.callId } : {},
      reason: typeof payload.reason === 'string' ? payload.reason : `调用工具 ${toolName}`,
      expiresAt: new Date(Date.now() + resolveNumber(this.options.approvalTimeoutMs)).toISOString(),
    });
  }

  private handleQuestionRequested(state: DshSessionState, rpcId: string, payload: Record<string, unknown>): void {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : state.dshSessionId;
    const questions = Array.isArray(payload.questions) ? payload.questions as DshQuestion[] : [];
    state.pending.set(rpcId, { kind: 'question', rpcId, sessionId, questions });
    const reason = questions[0]?.question ?? '操作需要确认';
    state.sink.send({
      type: 'agent.approval.request',
      sessionId: state.webSessionId,
      approvalId: rpcId,
      tool: 'ask_user_question',
      args: { questions },
      reason,
      expiresAt: new Date(Date.now() + resolveNumber(this.options.approvalTimeoutMs)).toISOString(),
    });
  }

  private async callUnary(method: string, payload: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: unknown }> {
    const result = await this.postEnvelope(randomUUID(), method, payload);
    return { ok: (result as { result?: { ok?: boolean } }).result?.ok === true, value: (result as { result?: { value?: unknown } }).result?.value, error: (result as { result?: { error?: unknown } }).result?.error };
  }

  /**
   * POST /api/respond resolves a pending approval or question. The envelope
   * differs from unary calls: `{ type: "client-response", rpcId, result }`
   * with `result` at the top level (no `method`/`payload`).
   */
  private async postRespond(rpcId: string, result: Record<string, unknown>): Promise<unknown> {
    const baseUrl = resolveString(this.options.baseUrl).replace(/\/+$/, '');
    const token = resolveOptional(this.options.token);
    const response = await fetch(`${baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ type: 'client-response', rpcId, result }),
    });
    if (!response.ok) throw new Error(`dsh api respond failed with HTTP ${response.status}`);
    return response.json();
  }

  private async postEnvelope(rpcId: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
    const baseUrl = resolveString(this.options.baseUrl).replace(/\/+$/, '');
    const token = resolveOptional(this.options.token);
    const response = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    });
    if (!response.ok) throw new Error(`dsh api ${method} failed with HTTP ${response.status}`);
    return response.json();
  }
}
