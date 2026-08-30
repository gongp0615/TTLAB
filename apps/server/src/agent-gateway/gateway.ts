import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { ApprovalManager } from './approvals.js';
import type { AgentEngine, AgentEngineOpenContext } from './engine-adapter.js';
import type { AgentSink } from './engine.js';
import type { AgentClientMessage, AgentServerMessage, SessionStatus } from './types.js';
import type { McpServerContext } from '../mcp/index.js';

export interface AgentGatewayOptions {
  engine: AgentEngine;
  approvals: ApprovalManager;
  mcpContext: McpServerContext;
  maxSessions: number | (() => number);
  logAgent: (sessionId: string, detail: Record<string, unknown>) => void;
  auditApproval: (sessionId: string, approvalId: string, tool: string, decision: string, args: Record<string, unknown>) => void;
}

interface AgentSession {
  sessionId: string;
  socket: WebSocket;
  sink?: AgentSink;
  status: SessionStatus;
  turnRunning: boolean;
  engineSessionId?: string;
  engineOpenPromise?: Promise<void>;
  windowKey?: string;
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
      status: 'idle',
      turnRunning: false,
    };
    session.sink = this.wrapSink(session);
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
      if (session.engineSessionId !== undefined) void this.options.engine.closeSession(session.engineSessionId).catch(() => undefined);
    });
  }

  private handleMessage(session: AgentSession, message: AgentClientMessage): void {
    if (message.type === 'agent.session.open') {
      if (typeof message.sessionId === 'string' && message.sessionId.trim().length > 0 && session.windowKey === undefined) {
        session.windowKey = message.sessionId.trim();
      }
      return;
    }
    if (message.type === 'agent.approval.response') {
      if (typeof message.approvalId !== 'string' || (message.decision !== 'approved' && message.decision !== 'rejected')) return;
      if (session.engineSessionId === undefined) return;
      void this.options.engine.respondApproval(session.engineSessionId, message.approvalId, message.decision).catch((error) => {
        this.send(session, { type: 'agent.error', sessionId: session.sessionId, code: 'AGENT_ENGINE_ERROR', message: error instanceof Error ? error.message : 'approval response failed' });
      });
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

  private async openEngine(session: AgentSession): Promise<void> {
    if (session.engineSessionId !== undefined) return;
    if (session.engineOpenPromise === undefined) {
      const engineSessionId = session.windowKey ?? session.sessionId;
      const openContext: AgentEngineOpenContext = {
        webSessionId: engineSessionId,
        sink: session.sink as AgentSink,
        approvals: this.options.approvals,
        mcpContext: this.options.mcpContext,
        auditApproval: (approvalId, tool, decision, args) => this.options.auditApproval(session.sessionId, approvalId, tool, decision, args),
      };
      session.engineOpenPromise = this.options.engine.openSession(openContext)
        .then(() => { session.engineSessionId = engineSessionId; })
        .finally(() => { delete session.engineOpenPromise; });
    }
    await session.engineOpenPromise;
  }

  private async runTurn(session: AgentSession, content: string): Promise<void> {
    session.turnRunning = true;
    session.status = 'thinking';
    this.send(session, { type: 'agent.session.status', sessionId: session.sessionId, status: 'thinking' });
    this.options.logAgent(session.sessionId, { role: 'user', content });
    try {
      await this.openEngine(session);
      await this.options.engine.submit(session.engineSessionId as string, content);
    } catch (error) {
      session.turnRunning = false;
      session.status = 'error';
      this.send(session, { type: 'agent.error', sessionId: session.sessionId, code: 'AGENT_ENGINE_ERROR', message: error instanceof Error ? error.message : 'agent engine failed' });
      this.send(session, { type: 'agent.session.status', sessionId: session.sessionId, status: 'error' });
    }
  }

  private wrapSink(session: AgentSession): AgentSink {
    return {
      send: (message) => {
        if (message.type === 'agent.message.done') {
          session.turnRunning = false;
          session.status = 'idle';
          this.send(session, { type: 'agent.session.status', sessionId: session.sessionId, status: 'idle' });
        } else if (message.type === 'agent.error') {
          session.turnRunning = false;
          session.status = 'error';
        }
        this.send(session, message);
      },
    };
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
