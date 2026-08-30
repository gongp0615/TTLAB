import { toolDefinitions, type McpServerContext, type ToolResult } from '../mcp/index.js';
import type { LlmClient } from './llm.js';
import type { AgentServerMessage, ChatMessage } from './types.js';

export interface AgentSink {
  send(message: AgentServerMessage): void;
}

export interface AgentTurnContext {
  sessionId: string;
  sink: AgentSink;
  mcpContext: McpServerContext;
}

export interface ServerNativeEngineOptions {
  llm: LlmClient;
  maxIterations?: number;
}

export class ServerNativeEngine {
  private readonly llm: LlmClient;
  private readonly maxIterations: number;
  private readonly toolSpecs = toolDefinitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

  constructor(options: ServerNativeEngineOptions) {
    this.llm = options.llm;
    this.maxIterations = options.maxIterations ?? 8;
  }

  async runTurn(context: AgentTurnContext, messages: ChatMessage[], userContent: string): Promise<ChatMessage[]> {
    const history: ChatMessage[] = [...messages, { role: 'user', content: userContent }];
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const response = await this.llm.chat({ messages: history, tools: this.toolSpecs });
      const toolCalls = response.toolCalls;
      if (toolCalls === undefined || toolCalls.length === 0) {
        const content = response.content ?? '';
        if (content) {
          history.push({ role: 'assistant', content });
          context.sink.send({ type: 'agent.message.delta', sessionId: context.sessionId, delta: content });
        }
        context.sink.send({ type: 'agent.message.done', sessionId: context.sessionId });
        return history;
      }
      history.push({ role: 'assistant', content: response.content ?? '', toolCalls });
      for (const call of toolCalls) {
        context.sink.send({ type: 'agent.tool.status', sessionId: context.sessionId, tool: call.name, toolStatus: 'running', args: call.arguments });
        const result = await this.executeTool(context, call);
        history.push({ role: 'tool', toolCallId: call.id, content: result.text });
        context.sink.send({ type: 'agent.tool.status', sessionId: context.sessionId, tool: call.name, toolStatus: result.isError ? 'error' : 'done', result });
      }
    }
    context.sink.send({ type: 'agent.error', sessionId: context.sessionId, code: 'AGENT_LOOP_LIMIT', message: `agent exceeded ${this.maxIterations} tool call rounds` });
    context.sink.send({ type: 'agent.message.done', sessionId: context.sessionId });
    return history;
  }

  private async executeTool(context: AgentTurnContext, call: { id: string; name: string; arguments: Record<string, unknown> }): Promise<ToolResult> {
    const tool = toolDefinitions.find((item) => item.name === call.name);
    if (tool === undefined) return { text: JSON.stringify({ code: 'TOOL_NOT_FOUND', message: `tool ${call.name} not found`, retryable: false }), isError: true };

    if (call.name === 'command_execute') {
      const args = call.arguments as { clientId?: string; deviceId: string; operation: string; parameters: Record<string, string> };
      const result = context.mcpContext.dispatchCommand({ ...(args.clientId !== undefined ? { clientId: args.clientId } : {}), deviceId: args.deviceId, operation: args.operation, parameters: args.parameters ?? {}, actor: `agent:${context.sessionId}` });
      if (!result.ok) return { text: JSON.stringify(result.error), isError: true };
      return { text: JSON.stringify({ commandId: result.commandId, status: 'dispatched' }) };
    }
    if (call.name === 'client_update') {
      const args = call.arguments as { clientId: string; version: string };
      const result = context.mcpContext.dispatchUpdate({ clientId: args.clientId, version: args.version, actor: `agent:${context.sessionId}` });
      if (!result.ok) return { text: JSON.stringify(result.error), isError: true };
      return { text: JSON.stringify({ updateId: result.updateId, version: result.version, status: 'dispatched' }) };
    }
    return tool.handler(context.mcpContext, call.arguments);
  }
}
