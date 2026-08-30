import { isLogType, type LogQueryOptions, type LogQueryResult } from '../logstore/index.js';

export const highRiskOperations: ReadonlySet<string> = new Set(['system.reset', 'device.reboot', 'firmware.flash']);

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface McpServerContext {
  serverName: string;
  serverVersion: string;
  listClients(): Array<Record<string, unknown>>;
  listDevices(): Array<Record<string, unknown>>;
  getDeviceStatus(deviceId: string): Record<string, unknown> | undefined;
  queryLogs(options: LogQueryOptions): Promise<LogQueryResult>;
  queryAudit(options: LogQueryOptions): Promise<LogQueryResult>;
  getCommandStatus(commandId: string): Record<string, unknown> | undefined;
  dispatchCommand(input: { clientId?: string; deviceId: string; operation: string; parameters: Record<string, string>; actor: string }): { ok: true; commandId: string } | { ok: false; error: { code: string; message: string; retryable: boolean } };
  dispatchUpdate(input: { clientId: string; version: string; actor: string }): { ok: true; updateId: string; version: string } | { ok: false; error: { code: string; message: string; retryable: boolean } };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (context: McpServerContext, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}

const logQuerySchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    types: { type: 'array', items: { type: 'string', enum: ['device', 'event', 'command', 'audit', 'agent'] }, description: 'log categories to search; defaults to device' },
    clientId: { type: 'string', description: 'exact client id filter' },
    deviceId: { type: 'string', description: 'exact device id filter' },
    commandId: { type: 'string', description: 'exact command id filter' },
    actor: { type: 'string', description: 'exact actor filter (audit)' },
    sessionId: { type: 'string', description: 'exact agent session id filter' },
    from: { type: 'string', description: 'ISO 8601 UTC start time; defaults to 24 hours ago' },
    to: { type: 'string', description: 'ISO 8601 UTC end time; defaults to now' },
    keyword: { type: 'string', description: 'case-insensitive substring search over the whole entry' },
    limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'max results; defaults to 100' },
    offset: { type: 'integer', minimum: 0, maximum: 100000, description: 'pagination offset; defaults to 0' },
  },
  additionalProperties: false,
};

function toLogQueryOptions(args: Record<string, unknown>): LogQueryOptions {
  const options: LogQueryOptions = {};
  if (Array.isArray(args.types)) options.types = args.types.filter(isLogType);
  for (const field of ['clientId', 'deviceId', 'commandId', 'actor', 'sessionId', 'from', 'to', 'keyword'] as const) {
    if (typeof args[field] === 'string' && args[field].length > 0) options[field] = args[field];
  }
  if (typeof args.limit === 'number') options.limit = args.limit;
  if (typeof args.offset === 'number') options.offset = args.offset;
  return options;
}

function notFound(code: string, message: string): ToolResult {
  return { text: JSON.stringify({ code, message, retryable: false }), isError: true };
}

export const toolDefinitions: readonly ToolDefinition[] = [
  {
    name: 'client_list',
    description: 'List all TTLAB clients with their connection status, hello information, and latest device snapshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (context) => ({ text: JSON.stringify(context.listClients()) }),
  },
  {
    name: 'device_list',
    description: 'List all serial devices across clients with port roles, connection status, and the owning client id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (context) => ({ text: JSON.stringify(context.listDevices()) }),
  },
  {
    name: 'device_status',
    description: 'Return the detailed status of a single device by its device id, including ports and owning client.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'the device id as shown by device_list' } },
      required: ['deviceId'],
      additionalProperties: false,
    },
    handler: (context, args) => {
      const device = context.getDeviceStatus(args.deviceId as string);
      if (device === undefined) return notFound('DEVICE_OFFLINE', 'device not found');
      return { text: JSON.stringify(device) };
    },
  },
  {
    name: 'log_query',
    description: 'Query persisted TTLAB logs: device log stream, client events, command lifecycle, audit records, and agent sessions. Use this to inspect what happened on devices and why.',
    inputSchema: logQuerySchema,
    handler: async (context, args) => {
      const result = await context.queryLogs(toLogQueryOptions(args));
      return { text: JSON.stringify(result) };
    },
  },
  {
    name: 'audit_query',
    description: 'Query operator and agent audit records such as command dispatch and client update dispatch.',
    inputSchema: logQuerySchema,
    handler: async (context, args) => {
      const result = await context.queryAudit(toLogQueryOptions(args));
      return { text: JSON.stringify(result) };
    },
  },
  {
    name: 'command_status',
    description: 'Return the status and result of a previously dispatched command by its command id.',
    inputSchema: {
      type: 'object',
      properties: { commandId: { type: 'string', description: 'the command id returned by command_execute' } },
      required: ['commandId'],
      additionalProperties: false,
    },
    handler: (context, args) => {
      const status = context.getCommandStatus(args.commandId as string);
      if (status === undefined) return notFound('COMMAND_NOT_FOUND', 'command not found');
      return { text: JSON.stringify(status) };
    },
  },
  {
    name: 'command_execute',
    description: 'Dispatch a serial operation to a device on a TTLAB client. Low-risk operations execute immediately. High-risk operations (system.reset, device.reboot) return APPROVAL_REQUIRED; when you receive that error, ask the operator for explicit approval with ask_user_question (offer yes/no options), then retry the same call after they approve.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'target client id; resolved from deviceId when omitted' },
        deviceId: { type: 'string', description: 'target device id as shown by device_list' },
        operation: { type: 'string', description: 'one of the enabled operations, e.g. system.ping, system.version, hdmi.status, hdmi.switch, usb.status, usb.path, hardware.rgb, hardware.lcd' },
        parameters: { type: 'object', additionalProperties: { type: 'string' }, description: 'operation parameters as short strings' },
      },
      required: ['deviceId', 'operation'],
      additionalProperties: false,
    },
    handler: (context, args) => {
      const operation = args.operation as string;
      // Approval for high-risk operations is enforced upstream by the dsh
      // approval gate (agent path); dispatch is always audited with actor.
      const parameters = (args.parameters ?? {}) as Record<string, string>;
      const result = context.dispatchCommand({
        ...(args.clientId !== undefined ? { clientId: args.clientId as string } : {}),
        deviceId: args.deviceId as string,
        operation,
        parameters,
        actor: 'agent',
      });
      if (!result.ok) return { text: JSON.stringify(result.error), isError: true };
      return { text: JSON.stringify({ commandId: result.commandId, status: 'dispatched' }) };
    },
  },
  {
    name: 'client_update',
    description: 'Trigger a software update on a TTLAB client. Approval for the update is enforced upstream by the dsh approval gate (agent path); dispatch is always audited with actor.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'the client id to update' },
        version: { type: 'string', description: 'release version that exists on the server' },
      },
      required: ['clientId', 'version'],
      additionalProperties: false,
    },
    handler: (context, args) => {
      const result = context.dispatchUpdate({ clientId: args.clientId as string, version: args.version as string, actor: 'agent' });
      if (!result.ok) return { text: JSON.stringify(result.error), isError: true };
      return { text: JSON.stringify({ updateId: result.updateId, version: result.version, status: 'dispatched' }) };
    },
  },
];
