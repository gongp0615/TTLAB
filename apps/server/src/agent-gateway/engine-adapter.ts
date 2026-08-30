import type { ApprovalManager } from './approvals.js';
import type { AgentSink, AgentTurnContext, ServerNativeEngine } from './engine.js';
import type { McpServerContext } from '../mcp/index.js';
import type { ChatMessage } from './types.js';

/**
 * Shared context handed to an engine when a web agent session opens. The
 * engine keeps its own per-session state (conversation history, dsh session
 * mapping, event subscriptions) keyed by `webSessionId`.
 */
export interface AgentEngineOpenContext {
  webSessionId: string;
  sink: AgentSink;
  approvals: ApprovalManager;
  mcpContext: McpServerContext;
  auditApproval: (approvalId: string, tool: string, decision: string, args: Record<string, unknown>) => void;
}

/**
 * Agent engine adapter. The gateway drives engines uniformly through this
 * interface, so the web chat panel can run either the built-in
 * `server-native` engine (direct LLM calls) or an external DeepSeek Harness
 * (dsh) that owns context, tool calls, and approvals.
 */
export interface AgentEngine {
  readonly kind: 'server-native' | 'dsh';
  openSession(context: AgentEngineOpenContext): Promise<void>;
  submit(webSessionId: string, content: string): Promise<void>;
  respondApproval(webSessionId: string, approvalId: string, decision: 'approved' | 'rejected'): Promise<void>;
  closeSession(webSessionId: string): Promise<void>;
}

interface ServerNativeSessionState extends AgentEngineOpenContext {
  messages: ChatMessage[];
}

/**
 * Wraps {@link ServerNativeEngine} as an {@link AgentEngine}. Conversation
 * history and the system prompt live here instead of in the gateway.
 */
export class ServerNativeEngineAdapter implements AgentEngine {
  readonly kind = 'server-native' as const;
  private readonly states = new Map<string, ServerNativeSessionState>();

  constructor(
    private readonly engine: ServerNativeEngine,
    private readonly systemPrompt: string | (() => string),
  ) {}

  async openSession(context: AgentEngineOpenContext): Promise<void> {
    this.states.set(context.webSessionId, {
      ...context,
      messages: [{ role: 'system', content: typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt }],
    });
  }

  async submit(webSessionId: string, content: string): Promise<void> {
    const state = this.states.get(webSessionId);
    if (state === undefined) throw new Error(`agent session not open: ${webSessionId}`);
    const turnContext: AgentTurnContext = {
      sessionId: webSessionId,
      sink: state.sink,
      mcpContext: state.mcpContext,
    };
    state.messages = await this.engine.runTurn(turnContext, state.messages, content);
  }

  async respondApproval(webSessionId: string, approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const state = this.states.get(webSessionId);
    if (state === undefined) return;
    state.approvals.respond(approvalId, decision);
  }

  async closeSession(webSessionId: string): Promise<void> {
    this.states.delete(webSessionId);
  }
}
