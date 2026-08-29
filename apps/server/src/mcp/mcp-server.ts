import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_INTERNAL_ERROR,
  MCP_NOT_INITIALIZED,
  MCP_TOOL_NOT_FOUND,
  MCP_TOOL_EXECUTION_ERROR,
  JsonRpcProtocolError,
  errorResponse,
  parseJsonRpcMessage,
  successResponse,
  type JsonRpcErrorResponse,
  type JsonRpcResult,
  type JsonRpcResponse,
  type JsonRpcId,
} from './protocol.js';
import { toolDefinitions, type McpServerContext } from './tools.js';
import { validateSchema } from './validate.js';

export const mcpProtocolVersion = '2025-06-18';

export interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, unknown> };
  serverInfo: { name: string; version: string };
}

export class McpServer {
  private initialized = false;

  constructor(private readonly context: McpServerContext) {}

  async handle(raw: unknown): Promise<JsonRpcResult> {
    let request: ReturnType<typeof parseJsonRpcMessage>;
    try {
      request = parseJsonRpcMessage(raw);
    } catch (error) {
      const protocolError = error instanceof JsonRpcProtocolError ? error : new JsonRpcProtocolError(JSON_RPC_INTERNAL_ERROR, 'invalid message');
      return errorResponse(null, protocolError.code, protocolError.message);
    }
    if (request.kind === 'notification') {
      if (request.method === 'notifications/initialized') this.initialized = true;
      return null;
    }
    const { id } = request;
    try {
      if (request.method === 'initialize') {
        this.initialized = true;
        return successResponse(id, this.initializeResult(request.params));
      }
      if (!this.initialized) return errorResponse(id, MCP_NOT_INITIALIZED, 'server not initialized');
      if (request.method === 'ping') return successResponse(id, {});
      if (request.method === 'tools/list') return successResponse(id, { tools: toolDefinitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      if (request.method === 'tools/call') return this.callTool(id, request.params);
      return errorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${request.method}`);
    } catch (error) {
      return errorResponse(id, JSON_RPC_INTERNAL_ERROR, error instanceof Error ? error.message : 'internal error');
    }
  }

  private initializeResult(params: unknown): InitializeResult {
    const candidate = params as { protocolVersion?: unknown } | undefined;
    const protocolVersion = typeof candidate?.protocolVersion === 'string' && candidate.protocolVersion.length > 0 ? candidate.protocolVersion : mcpProtocolVersion;
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: this.context.serverName, version: this.context.serverVersion },
    };
  }

  private async callTool(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse | JsonRpcErrorResponse> {
    const candidate = params as { name?: unknown; arguments?: unknown } | undefined;
    if (!candidate || typeof candidate !== 'object' || typeof candidate.name !== 'string') {
      return errorResponse(id, JSON_RPC_INVALID_PARAMS, 'tool name is required');
    }
    const tool = toolDefinitions.find((item) => item.name === candidate.name);
    if (tool === undefined) return errorResponse(id, MCP_TOOL_NOT_FOUND, `tool not found: ${candidate.name}`);
    const args = candidate.arguments !== undefined && candidate.arguments !== null && typeof candidate.arguments === 'object' && !Array.isArray(candidate.arguments)
      ? candidate.arguments as Record<string, unknown>
      : {};
    const validationError = validateSchema(args, tool.inputSchema);
    if (validationError !== undefined) return errorResponse(id, JSON_RPC_INVALID_PARAMS, `${tool.name}: ${validationError}`);
    try {
      const result = await tool.handler(this.context, args);
      return successResponse(id, { content: [{ type: 'text', text: result.text }], isError: result.isError ?? false });
    } catch (error) {
      return errorResponse(id, MCP_TOOL_EXECUTION_ERROR, error instanceof Error ? error.message : 'tool execution failed');
    }
  }
}
