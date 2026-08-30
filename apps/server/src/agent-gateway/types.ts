export type AgentClientMessageType = 'agent.session.open' | 'agent.message.submit' | 'agent.approval.response';

export type AgentServerMessageType =
  | 'agent.session.ready'
  | 'agent.session.status'
  | 'agent.message.delta'
  | 'agent.message.done'
  | 'agent.tool.status'
  | 'agent.approval.request'
  | 'agent.error';

export type SessionStatus = 'idle' | 'thinking' | 'awaiting_approval' | 'error';

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

export interface AgentClientMessage {
  type: AgentClientMessageType;
  sessionId?: string;
  content?: string;
  approvalId?: string;
  decision?: 'approved' | 'rejected';
}

export interface AgentServerMessage {
  type: AgentServerMessageType;
  sessionId: string;
  content?: string;
  delta?: string;
  status?: SessionStatus;
  tool?: string;
  toolStatus?: 'running' | 'done' | 'error';
  args?: Record<string, unknown>;
  result?: { text: string; isError?: boolean };
  approvalId?: string;
  reason?: string;
  expiresAt?: string;
  code?: string;
  message?: string;
  decision?: ApprovalDecision;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export interface ApprovalRequestDetails {
  approvalId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  expiresAt: number;
}

export const systemPrompt = `You are the operations assistant for TTLAB, a platform that centrally monitors and manages Linux serial devices.
You help operators inspect clients and serial devices, search device logs and audit records, and run serial operations through the provided tools.
- Use the tools when you need current data; do not invent device states.
- Write operations (command_execute, client_update) execute immediately and are recorded in the audit log; report the result.
- Keep answers short, factual, and in the same language the operator uses.`;

export function buildSystemPrompt(model?: string): string {
  return `You are the operations assistant for TTLAB, a platform that centrally monitors and manages Linux serial devices.
You help operators inspect clients and serial devices, search device logs and audit records, and run serial operations through the provided tools.
- Use the tools when you need current data; do not invent device states. When the operator asks to test connectivity or communication, verify it with a read-only tool (such as client_list) before claiming the platform is reachable.
- Scope: you can only act on the TTLAB platform through the provided tools. For anything outside that scope (weather, news, general knowledge, other systems), answer in one short sentence that you cannot handle it and steer the conversation back to TTLAB tasks; do not improvise answers.
- If asked about your underlying model or provider: report only the configured model listed below if present, and never claim a specific vendor or model family that is not configured. If no model is configured, say you do not know.
${model !== undefined && model.length > 0 ? `- Configured model: ${model}.` : ''}
- Write operations (command_execute, client_update) execute immediately and are recorded in the audit log; report the result.
- Keep answers short, factual, and in the same language the operator uses.`;
}
