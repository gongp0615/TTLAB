import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer, type InitializeResult, type McpServerContext, type JsonRpcErrorResponse, type JsonRpcResponse } from '../apps/server/src/mcp/index.js';

function fakeContext(): McpServerContext {
  return {
    serverName: 'ttlab',
    serverVersion: 'test',
    listClients: () => [{ clientId: 'client-1', status: 'online' }],
    listDevices: () => [{ deviceId: 'tvbox:1', clientId: 'client-1' }],
    getDeviceStatus: (deviceId) => (deviceId === 'tvbox:1' ? { deviceId, clientId: 'client-1' } : undefined),
    queryLogs: async () => ({ data: [{ ts: '2026-08-29T00:00:00.000Z', type: 'device', clientId: 'client-1', deviceId: 'tvbox:1', data: { sequence: 1 } }], hasMore: false, nextOffset: 0, truncated: false }),
    queryAudit: async () => ({ data: [], hasMore: false, nextOffset: 0, truncated: false }),
    getCommandStatus: (commandId) => (commandId === 'cmd-1' ? { commandId, status: 'dispatched' } : undefined),
    dispatchCommand: (input) => (input.operation === 'system.ping' ? { ok: true, commandId: 'cmd-new' } : { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'operation is not enabled', retryable: false } }),
    dispatchUpdate: (input) => (input.version === '1.1.0' ? { ok: true, updateId: 'upd-1', version: input.version } : { ok: false, error: { code: 'RELEASE_NOT_FOUND', message: 'release not found', retryable: false } }),
  };
}

async function initializedServer(): Promise<McpServer> {
  const server = new McpServer(fakeContext());
  await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  return server;
}

test('rejects malformed JSON-RPC messages', async () => {
  const server = new McpServer(fakeContext());
  const result = await server.handle({ jsonrpc: '1.0', method: 'ping' }) as JsonRpcErrorResponse;
  assert.equal(result.error.code, -32600);
  const array = await server.handle([]) as JsonRpcErrorResponse;
  assert.equal(array.error.code, -32600);
});

test('initialize returns protocol version, capabilities, and server info', async () => {
  const server = new McpServer(fakeContext());
  const result = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh', version: '0.1' } } }) as JsonRpcResponse;
  const payload = result.result as InitializeResult;
  assert.equal(payload.protocolVersion, '2025-06-18');
  assert.deepEqual(payload.capabilities, { tools: {} });
  assert.equal(payload.serverInfo.name, 'ttlab');
});

test('requires initialize before other methods', async () => {
  const server = new McpServer(fakeContext());
  const result = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as JsonRpcErrorResponse;
  assert.equal(result.error.code, -32000);
});

test('notifications are acknowledged without a response', async () => {
  const server = new McpServer(fakeContext());
  const result = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(result, null);
});

test('tools/list exposes the TTLAB tool set', async () => {
  const server = await initializedServer();
  const result = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as JsonRpcResponse;
  const names = (result.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['audit_query', 'client_list', 'client_update', 'command_execute', 'command_status', 'device_list', 'device_status', 'log_query']);
});

test('tools/call rejects unknown tools and invalid arguments', async () => {
  const server = await initializedServer();
  const unknown = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bogus', arguments: {} } }) as JsonRpcErrorResponse;
  assert.equal(unknown.error.code, -32002);
  const invalid = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'device_status', arguments: {} } }) as JsonRpcErrorResponse;
  assert.equal(invalid.error.code, -32602);
  const extra = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'client_list', arguments: { unexpected: 'x' } } }) as JsonRpcErrorResponse;
  assert.equal(extra.error.code, -32602);
});

test('command.execute dispatches low-risk operations and blocks high-risk ones', async () => {
  const server = await initializedServer();
  const lowRisk = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'command_execute', arguments: { deviceId: 'tvbox:1', operation: 'system.ping' } } }) as JsonRpcResponse;
  const lowPayload = lowRisk.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(lowPayload.isError, false);
  assert.ok(lowPayload.content[0]?.text.includes('cmd-new'));

  const highRisk = await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'command_execute', arguments: { deviceId: 'tvbox:1', operation: 'device.reboot' } } }) as JsonRpcResponse;
  const highPayload = highRisk.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(highPayload.isError, true);
  assert.ok(highPayload.content[0]?.text.includes('APPROVAL_REQUIRED'));

  const update = await server.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'client_update', arguments: { clientId: 'client-1', version: '1.1.0' } } }) as JsonRpcResponse;
  const updatePayload = update.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(updatePayload.isError, true);
  assert.ok(updatePayload.content[0]?.text.includes('APPROVAL_REQUIRED'));
});

test('log.query and audit.query return query results', async () => {
  const server = await initializedServer();
  const logs = await server.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'log_query', arguments: { types: ['device'], clientId: 'client-1' } } }) as JsonRpcResponse;
  const logsPayload = logs.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(logsPayload.isError, false);
  assert.ok(logsPayload.content[0]?.text.includes('tvbox'));

  const audits = await server.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'audit_query', arguments: {} } }) as JsonRpcResponse;
  const auditsPayload = audits.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(auditsPayload.isError, false);
});
