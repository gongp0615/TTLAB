export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const MCP_NOT_INITIALIZED = -32000;
export const MCP_TOOL_NOT_FOUND = -32002;
export const MCP_TOOL_EXECUTION_ERROR = -32003;

export type JsonRpcId = string | number;

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export type JsonRpcResult = JsonRpcResponse | JsonRpcErrorResponse | null;

export interface JsonRpcProtocolErrorOptions {
  code: number;
  message: string;
}

export class JsonRpcProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ParsedRequest {
  kind: 'request';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface ParsedNotification {
  kind: 'notification';
  method: string;
  params?: unknown;
}

export function parseJsonRpcMessage(raw: unknown): ParsedRequest | ParsedNotification {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JsonRpcProtocolError(JSON_RPC_INVALID_REQUEST, 'message must be a JSON-RPC object');
  const value = raw as Record<string, unknown>;
  if (value.jsonrpc !== '2.0' || typeof value.method !== 'string') throw new JsonRpcProtocolError(JSON_RPC_INVALID_REQUEST, 'invalid JSON-RPC message');
  const params = value.params;
  if (!('id' in value)) {
    return { kind: 'notification', method: value.method, ...(params !== undefined ? { params } : {}) };
  }
  const id = value.id;
  if (typeof id !== 'string' && typeof id !== 'number') throw new JsonRpcProtocolError(JSON_RPC_INVALID_REQUEST, 'invalid message id');
  return { kind: 'request', id, method: value.method, ...(params !== undefined ? { params } : {}) };
}

export function errorResponse(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
