import type { ChatMessage } from './types.js';

export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmChatRequest {
  messages: ChatMessage[];
  tools: LlmToolSpec[];
}

export interface LlmChatResult {
  content?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmClient {
  chat(request: LlmChatRequest): Promise<LlmChatResult>;
}

export interface LlmClientOptions {
  baseUrl: string | (() => string);
  apiKey?: string | (() => string | undefined);
  model: string | (() => string);
}

export class LlmError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

function resolveString(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value;
}

function resolveOptional(value: string | (() => string | undefined) | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'function' ? value() : value;
}

interface OpenAiMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

function toOpenAiMessage(message: ChatMessage): OpenAiMessage {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}) };
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
    };
  }
  return { role: message.role, content: message.content };
}

export class DeepSeekApiClient implements LlmClient {
  private readonly baseUrl: string | (() => string);
  private readonly apiKey: string | (() => string | undefined) | undefined;
  private readonly model: string | (() => string);

  constructor(options: LlmClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    const baseUrl = resolveString(this.baseUrl).replace(/\/+$/, '');
    const apiKey = resolveOptional(this.apiKey);
    const model = resolveString(this.model);
    const payload = {
      model,
      messages: request.messages.map(toOpenAiMessage),
      ...(request.tools.length > 0 ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
      tool_choice: 'auto',
      stream: false,
    };
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new LlmError(`LLM request failed with status ${response.status}`, response.status);
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) return {};
    const content = message.content ?? undefined;
    const toolCalls = message.tool_calls?.flatMap((call) => {
      const fn = call.function;
      const name = fn?.name;
      const id = call.id;
      if (!name || !id) return [];
      let args: Record<string, unknown> = {};
      try {
        args = fn?.arguments ? JSON.parse(fn.arguments) as Record<string, unknown> : {};
      } catch {
        args = {};
      }
      return [{ id, name, arguments: args }];
    });
    return { ...(content !== undefined ? { content } : {}), ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}) };
  }
}
