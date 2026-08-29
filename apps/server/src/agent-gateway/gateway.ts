import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { ApprovalManager } from './approvals.js';
import { ServerNativeEngine, type AgentTurnContext } from './engine.js';
import { systemPrompt, type AgentClientMessage, type AgentServerMessage, type ChatMessage, type SessionStatus } from './types.js';
import type { McpServerContext } from '../mcp/index.js';

export interface AgentGatewayOptions {
  engine: ServerNativeEngine;
  approvals: ApprovalManager;
  mcpContext: McpServerContext;
  maxSessions: number | (() => number);
  logAgent: (sessionId: string, detail: Record<string, unknown>) => void;
  auditApproval: (sessionId: string, approvalId: string, tool: string, decision: string, args: Record<string, unknown>) => void;
}

interface AgentSession {
  sessionId: string;
  socket: WebSocket;
  messages: ChatMessage[];
  status: SessionStatus;
  turnRunning: boolean;
}

export class AgentGateway {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly options: AgentGatewayOptions) {}

  attachServer(server: WebSocketServer): void {
    server.on('connection', (socket) => this.handleConnection(socket));
  }

  close(): void {
    for (const session of this.sessions.values()) {
      if (session.socket.readyState === WebSocket.OPEN) session.socket.close(1001, 'server shutting down');
    }
    this.sessions.clear();
    this.options.approvals.close();
  }

  private handleConnection(socket: WebSocket): void {
    const maxSessions = typeof this.options.maxSessions === 'function' ? this.options.maxSessions() : this.options.maxSessions;
    if (this.sessions.size >= maxSessions) {
      socket.close(1013, 'too many agent sessions');
      return;
    }
    const session: AgentSession = {
      sessionId: `session_${randomUUID()}`,
      socket,
      messages: [{ role: 'system', content: systemPrompt }],
      status: 'idle',
      turnRunning: false,
    };
    this.sessions.set(session.sessionId, session);
    this.send(session, { type: 'agent.session.ready', sessionId: session.sessionId, status: 'idle' });

    socket.on('message', (data) => {
      let message: AgentClientMessage;
      try {
        message = JSON.parse(data.toString()) as AgentClientMessage;
      } catch {
        return;
      }
      this.handleMessage(session, message);
    });
    socket.on('close', () => {
      this.options.approvals.rejectSession(session.sessionId);
      this.sessions.delete(session.sessionId);
    });
  }

  private handleMessage(session: AgentSession, message: AgentClientMessage): void {
    if (message.type === 'agent.session.open') return;
    if (message.type === 'agent.approval.response') {
      if (typeof message.approvalId !== 'string' || (message.decision !== 'approved' && message.decision !== 'rejected')) return;
      this.options.approvals.respond(message.approvalId, message.decision);
      return;
    }
    if (message.type === 'agent.message.submit') {
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (content.length === 0) return;
      if (session.turnRunning) {
        this.send(session, { type: 'agent.error', sessionId: session.sessionId, code: 'AGENT_BUSY', message: 'agent is already processing a message' });
        return;
      }
      void this.runTurn(session, content);
    }
  }

  private async runTurn(session: AgentSession, content: string): Promise<void> {
    session.turnRunning = true;
    session.status = 'thinking';
    this.send(session, { type: 'agent.session.status', sessionId: session.sessionId, status: 'thinking' });
    this.options.logAgent(session.sessionId, { role: 'user', content });
    const turnContext: AgentTurnContext = {
      sessionId: session.sessionId,
      sink: { send: (message) => this.send(session, message) },
      approvals: this.options.approvals,
      mcpContext: this.options.mcpContext,
      auditApproval: (approvalId, tool, decision, args) => this.options.auditApproval(session.sessionId, approvalId, tool, decision, args),
    };
    try {
      session.messages = await this.options.engine.runTurn(turnContext, session.messages, content);
      session.status = 'idle';
    } catch (error) {
      session.status = 'error';
      this.send(session, { type: 'agent.error', sessionId: session.sessionId, code: 'AGENT_ENGINE_ERROR', message: error instanceof Error ? error.message : 'agent engine failed' });
    } finally {
      session.turnRunning = false;
      this.send(session, { type: 'agent.session.status', sessionId: session.sessionId, status: session.status });
    }
  }

  private send(session: AgentSession, message: AgentServerMessage): void {
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
    if (message.type === 'agent.message.delta') {
      this.options.logAgent(session.sessionId, { role: 'assistant', content: message.delta });
    } else if (message.type === 'agent.tool.status') {
      this.options.logAgent(session.sessionId, { role: 'tool', tool: message.tool, toolStatus: message.toolStatus, args: message.args, result: message.result });
    } else if (message.type === 'agent.error') {
      this.options.logAgent(session.sessionId, { role: 'error', code: message.code, message: message.message });
    }
    if (message.type === 'agent.approval.request' && session.status !== 'awaiting_approval') {
      session.status = 'awaiting_approval';
      this.send(session, { type: 'agent.session.status', sessionId: session.sessionId, status: 'awaiting_approval' });
    }
  }
}
