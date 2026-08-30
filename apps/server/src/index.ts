import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  message,
  parseClientHello,
  parseClientSnapshot,
  parseCommandProgress,
  parseCommandResult,
  parseDeviceLogChunk,
  parseEnvelope,
  validateCommandParameters,
  type ClientHello,
  type ClientSnapshot,
  type CommandProgress,
  type CommandRequest,
  type DeviceLogChunk,
  type Envelope,
  type UpdateManifest,
} from '../../../packages/protocol/src/index.js';
import { LogStore, parseAuditQuery, parseLogQuery, type LogEntry } from './logstore/index.js';
import { WebLogSubscriptions } from './web-events.js';
import { FirmwareStore, FirmwareStoreError } from './firmware.js';
import { McpServer, type McpServerContext } from './mcp/index.js';
import { AgentGateway, ApprovalManager, DeepSeekApiClient, DshEngine, ServerNativeEngine, ServerNativeEngineAdapter, buildSystemPrompt, type AgentEngine } from './agent-gateway/index.js';
import { SettingsStore, parseAgentSettingsPatch, toAgentSettingsView } from './settings/index.js';

function loadConfigFile(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^TTLAB_[A-Z0-9_]+$/.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadConfigFile(process.env.TTLAB_CONFIG_FILE ?? './server.env');

const port = Number(process.env.TTLAB_SERVER_PORT ?? 9000);
const heartbeatTimeoutMs = Number(process.env.TTLAB_HEARTBEAT_TIMEOUT_MS ?? 30_000);
const configuredTokens = parseTokens(process.env.TTLAB_CLIENT_TOKENS ?? '');
const clientAuthEnabled = process.env.TTLAB_CLIENT_AUTH_ENABLED === '1';
const releaseDirectory = process.env.TTLAB_RELEASE_DIR ?? join(homedir(), '.local/state/ttlab-server/releases');
const firmwareMaxBytes = Number(process.env.TTLAB_FIRMWARE_MAX_BYTES ?? 1024 * 1024);
const tlsKeyFile = process.env.TTLAB_TLS_KEY_FILE;
const tlsCertFile = process.env.TTLAB_TLS_CERT_FILE;
const tlsRequired = process.env.TTLAB_TLS_REQUIRED === '1';
if ((tlsKeyFile && !tlsCertFile) || (!tlsKeyFile && tlsCertFile)) throw new Error('TTLAB_TLS_KEY_FILE and TTLAB_TLS_CERT_FILE must be configured together');
if (tlsRequired && (!tlsKeyFile || !tlsCertFile)) throw new Error('TLS is required but certificate files are not configured');
const tlsEnabled = Boolean(tlsKeyFile && tlsCertFile);
const publicBaseUrl = process.env.TTLAB_PUBLIC_BASE_URL ?? `${tlsEnabled ? 'https' : 'http'}://127.0.0.1:${port}`;
const webRoot = process.env.TTLAB_WEB_ROOT ?? '.';
const deviceTypesDirectory = process.env.TTLAB_DEVICE_TYPES_DIR ?? join(webRoot, 'device-types');
const logDirectory = process.env.TTLAB_LOG_DIR ?? './data/logs';
const logRetentionDays = Number(process.env.TTLAB_LOG_RETENTION_DAYS ?? 30);
const logFlushMs = Number(process.env.TTLAB_LOG_FLUSH_MS ?? 500);
const logFlushThresholdBytes = Number(process.env.TTLAB_LOG_FLUSH_THRESHOLD_BYTES ?? 256 * 1024);
const logMaxScanBytes = Number(process.env.TTLAB_LOG_MAX_SCAN_BYTES ?? 64 * 1024 * 1024);
const settingsStore = new SettingsStore(process.env.TTLAB_CONFIG_FILE ?? './server.env');
const supportedOperations = new Set([
  'hdmi.switch', 'hdmi.status', 'usb.path', 'usb.status', 'system.ping', 'system.version',
  'system.reset', 'device.reboot', 'hardware.rgb', 'hardware.lcd', 'firmware.flash',
]);
const firmwareStore = new FirmwareStore({ directory: releaseDirectory, maxBytes: firmwareMaxBytes });

interface RuntimeClient {
  clientId: string;
  status: 'syncing' | 'online' | 'offline';
  socket: WebSocket | undefined;
  hello?: ClientHello;
  snapshot?: ClientSnapshot;
  connectedAt?: string;
  lastHeartbeatAt?: string;
}

const clients = new Map<string, RuntimeClient>();
const commands = new Map<string, { request: CommandRequest; status: string; createdAt: string; progress?: CommandProgress; result?: unknown }>();
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const webEventServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const agentSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const logStore = new LogStore({
  directory: logDirectory,
  flushIntervalMs: logFlushMs,
  flushThresholdBytes: logFlushThresholdBytes,
  retentionDays: logRetentionDays,
  maxScanBytes: logMaxScanBytes,
  onError: (error, context) => {
    logError({ code: 'LOGSTORE_WRITE_FAILED', message: error.message, detail: { type: context.type, clientId: context.clientId } });
  },
});
logStore.start();
const staticFiles: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
};

function parseTokens(value: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const item of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = item.indexOf('=');
    if (separator > 0) tokens.set(item.slice(0, separator), item.slice(separator + 1));
  }
  return tokens;
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 64 * 1024) throw new Error('request body too large');
  }
  return JSON.parse(body || '{}');
}

function readManifest(version: string): UpdateManifest | undefined {
  if (!isSafeSegment(version)) return undefined;
  const manifestPath = `${releaseDirectory}/${version}/manifest.json`;
  if (!existsSync(manifestPath)) return undefined;
  const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as UpdateManifest;
  if (value.version !== version || !value.artifact || !value.sha256 || !value.signature) throw new Error('invalid release manifest');
  return value;
}

function clientView(client: RuntimeClient): Record<string, unknown> {
  return {
    clientId: client.clientId,
    status: client.status,
    hello: client.hello,
    snapshot: client.snapshot,
    connectedAt: client.connectedAt,
    lastHeartbeatAt: client.lastHeartbeatAt,
  };
}

const webLogSubscriptions = new WebLogSubscriptions({
  isKnownDevice: (deviceId) => [...clients.values()].some((client) => isDeviceInSnapshot(client, deviceId)),
});

function broadcastState(client: RuntimeClient): void {
  if (!client.snapshot) return;
  const event = JSON.stringify(message('client.snapshot', client.snapshot, client.clientId));
  for (const viewer of webEventServer.clients) {
    if (viewer.readyState === WebSocket.OPEN) viewer.send(event);
  }
}

function broadcastLog(payload: unknown, clientId: string): void {
  const chunk = payload as DeviceLogChunk;
  const event = JSON.stringify(message('device.log.chunk', payload, clientId));
  for (const viewer of webEventServer.clients) {
    if (viewer.readyState === WebSocket.OPEN && webLogSubscriptions.subscribedDevices(viewer).has(chunk.deviceId)) {
      viewer.send(event);
    }
  }
}

function broadcastSystemLog(entry: LogEntry): void {
  const event = JSON.stringify(message('system.log', entry, entry.clientId));
  for (const viewer of webEventServer.clients) {
    if (viewer.readyState === WebSocket.OPEN) viewer.send(event);
  }
}

function managedDevices(client: RuntimeClient): Array<Record<string, unknown>> {
  if (client.snapshot?.managedDevices) return client.snapshot.managedDevices.map((device) => ({ ...device, clientId: client.clientId }));
  return client.snapshot?.devices.map((device) => ({ ...device, clientId: client.clientId })) ?? [];
}

interface DeviceCategory {
  type: string;
  displayName: string;
}

// 设备分类来源：device-types/*/device.json 静态配置，合并当前在线设备上报的分类，
// 保证 Server 未部署 device-types 目录时仍能列出可用分类。
function listDeviceCategories(): DeviceCategory[] {
  const categories = new Map<string, string>();
  if (existsSync(deviceTypesDirectory)) {
    for (const entry of readdirSync(deviceTypesDirectory)) {
      if (!isSafeSegment(entry)) continue;
      const file = join(deviceTypesDirectory, entry, 'device.json');
      if (!existsSync(file)) continue;
      try {
        const profile = JSON.parse(readFileSync(file, 'utf8')) as { type?: unknown; displayName?: unknown };
        if (typeof profile.type === 'string' && profile.type.length > 0) {
          categories.set(profile.type, typeof profile.displayName === 'string' && profile.displayName.length > 0 ? profile.displayName : profile.type);
        }
      } catch {
        // 忽略损坏的设备分类配置文件
      }
    }
  }
  for (const client of clients.values()) {
    for (const device of client.snapshot?.managedDevices ?? []) {
      if (typeof device.deviceType === 'string' && device.deviceType.length > 0 && !categories.has(device.deviceType)) {
        categories.set(device.deviceType, device.deviceType);
      }
    }
  }
  return [...categories.entries()]
    .map(([type, displayName]) => ({ type, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'));
}

function logDeviceChunk(clientId: string, chunk: DeviceLogChunk): void {
  logStore.write({
    ts: chunk.capturedAt,
    type: 'device',
    clientId,
    deviceId: chunk.deviceId,
    data: { portId: chunk.portId, sequence: chunk.sequence, data: chunk.data, encoding: chunk.encoding, truncated: chunk.truncated },
  });
}

function logCommandState(clientId: string, payload: { commandId?: string; deviceId?: string }, status: string, request: CommandRequest | undefined, result: unknown): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    type: 'command',
    clientId,
    ...(payload.deviceId !== undefined ? { deviceId: payload.deviceId } : {}),
    ...(request?.deviceId !== undefined ? { deviceId: request.deviceId } : {}),
    ...(payload.commandId !== undefined ? { commandId: payload.commandId } : {}),
    data: {
      status,
      ...(request !== undefined ? { operation: request.operation, parameters: request.parameters } : {}),
      ...(result !== undefined ? { result } : {}),
    },
  };
  logStore.write(entry);
}

function logEvent(clientId: string | undefined, action: string, extra?: Record<string, unknown>, deviceId?: string): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    type: 'event',
    ...(clientId !== undefined ? { clientId } : {}),
    ...(deviceId !== undefined ? { deviceId } : {}),
    data: { action, ...(extra ?? {}) },
  };
  logStore.write(entry);
  broadcastSystemLog(entry);
}

function logError(options: { message: string; code?: string; clientId?: string; deviceId?: string; detail?: Record<string, unknown> }): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    type: 'error',
    ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    data: { ...(options.code !== undefined ? { code: options.code } : {}), message: options.message, ...(options.detail ?? {}) },
  };
  logStore.write(entry);
  broadcastSystemLog(entry);
}

// 设备可用性归一：serial 与 managed 设备的 status 枚举不同，统一把 offline/error/removed 视为不可用。
const unavailableStatuses = new Set(['offline', 'error', 'removed']);

function isUnavailable(status: string | undefined): boolean {
  return status !== undefined && unavailableStatuses.has(status);
}

function deviceMapOf(snapshot: ClientSnapshot | undefined): Map<string, { deviceId: string; status: string | undefined; deviceType: string | undefined }> {
  const map = new Map<string, { deviceId: string; status: string | undefined; deviceType: string | undefined }>();
  for (const device of snapshot?.devices ?? []) map.set(device.deviceId, { deviceId: device.deviceId, status: device.status, deviceType: device.deviceType });
  for (const device of snapshot?.managedDevices ?? []) map.set(device.deviceId, { deviceId: device.deviceId, status: device.status, deviceType: device.deviceType });
  return map;
}

// 对比前后快照，产出设备发现/移除/离线/恢复事件。
function diffAndLogDeviceEvents(clientId: string, previous: ClientSnapshot | undefined, next: ClientSnapshot): void {
  const previousDevices = deviceMapOf(previous);
  const nextDevices = deviceMapOf(next);
  for (const [deviceId, device] of nextDevices) {
    const prior = previousDevices.get(deviceId);
    if (prior === undefined) {
      logEvent(clientId, 'device.discovered', { status: device.status ?? '', ...(device.deviceType !== undefined ? { deviceType: device.deviceType } : {}) }, deviceId);
    } else if (isUnavailable(prior.status) && !isUnavailable(device.status)) {
      logEvent(clientId, 'device.online', { status: device.status ?? '' }, deviceId);
    } else if (!isUnavailable(prior.status) && isUnavailable(device.status)) {
      logEvent(clientId, 'device.offline', { status: device.status ?? '' }, deviceId);
    }
  }
  for (const [deviceId, device] of previousDevices) {
    if (!nextDevices.has(deviceId)) logEvent(clientId, 'device.removed', { status: device.status ?? '' }, deviceId);
  }
}

// Client 断开或心跳超时时，将其快照中仍可用的设备标记为离线。
function logDevicesOffline(clientId: string, snapshot: ClientSnapshot | undefined): void {
  if (!snapshot) return;
  const emitted = new Set<string>();
  for (const device of [...snapshot.devices, ...(snapshot.managedDevices ?? [])]) {
    if (emitted.has(device.deviceId) || isUnavailable(device.status)) continue;
    emitted.add(device.deviceId);
    logEvent(clientId, 'device.offline', { status: device.status }, device.deviceId);
  }
}

function writeAudit(options: { actor: string; clientId?: string; deviceId?: string; commandId?: string; action: string; detail: Record<string, unknown> }): void {
  logStore.write({
    ts: new Date().toISOString(),
    type: 'audit',
    ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
    actor: options.actor,
    data: { action: options.action, ...options.detail },
  });
}

type DispatchResult = { ok: true; commandId: string } | { ok: false; error: { code: string; message: string; retryable: boolean } };

// 指令派发失败：仅对系统级失败（目标离线、固件缺失）记录错误日志，常规参数校验错误不记为系统错误。
function dispatchFailure(input: { code: string; message: string; retryable: boolean; clientId?: string; deviceId?: string; operation?: string }): DispatchResult {
  if (input.code === 'CLIENT_OFFLINE' || input.code === 'DEVICE_OFFLINE' || input.code === 'RELEASE_NOT_FOUND') {
    logError({
      code: input.code,
      message: input.message,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      detail: { operation: input.operation },
    });
  }
  return { ok: false, error: { code: input.code, message: input.message, retryable: input.retryable } };
}

function resolveClientForDevice(deviceId: string): string | undefined {
  for (const client of clients.values()) {
    if (isDeviceInSnapshot(client, deviceId)) return client.clientId;
  }
  return undefined;
}

function isDeviceInSnapshot(client: RuntimeClient, deviceId: string): boolean {
  return Boolean(client.snapshot?.devices.some((device) => device.deviceId === deviceId) || client.snapshot?.managedDevices?.some((device) => device.deviceId === deviceId));
}

function dispatchCommand(input: { clientId?: string; deviceId: string; operation: string; parameters: Record<string, string>; actor: string }): DispatchResult {
  const clientId = input.clientId ?? resolveClientForDevice(input.deviceId);
  if (!clientId) return dispatchFailure({ code: 'DEVICE_OFFLINE', message: 'device is not associated with any client', retryable: true, deviceId: input.deviceId, operation: input.operation });
  const client = clients.get(clientId);
  if (!client || client.status !== 'online' || !client.socket || client.socket.readyState !== WebSocket.OPEN) {
    return dispatchFailure({ code: 'CLIENT_OFFLINE', message: 'client is not online', retryable: true, clientId, deviceId: input.deviceId, operation: input.operation });
  }
  const managedDevice = client.snapshot?.managedDevices?.find((device) => device.deviceId === input.deviceId);
  if (managedDevice?.operations && managedDevice.operations.length > 0) {
    const operationEntry = managedDevice.operations.find((item) => item.operation === input.operation);
    if (!operationEntry) {
      return { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'operation is not supported by this device', retryable: false } };
    }
    const validationError = validateCommandParameters(operationEntry, input.parameters);
    if (validationError) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: validationError, retryable: false } };
    }
  } else if (!supportedOperations.has(input.operation)) {
    return { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'operation is not enabled', retryable: false } };
  }
  if (![...Object.values(input.parameters)].every((value) => typeof value === 'string' && value.length <= 128)) {
    return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'command parameters must be short strings', retryable: false } };
  }
  if (!isDeviceInSnapshot(client, input.deviceId)) {
    return dispatchFailure({ code: 'DEVICE_OFFLINE', message: 'device is not in the client snapshot', retryable: true, clientId, deviceId: input.deviceId, operation: input.operation });
  }
  const now = Date.now();
  const expiresAt = new Date(now + (input.operation === 'firmware.flash' ? 10 * 60 * 1000 : 30_000)).toISOString();
  const command: CommandRequest = {
    commandId: `cmd_${randomUUID()}`,
    deviceId: input.deviceId,
    operation: input.operation,
    parameters: input.parameters,
    issuedAt: new Date(now).toISOString(),
    expiresAt,
  };
  if (input.operation === 'firmware.flash') {
    const version = input.parameters.version;
    const artifact = input.parameters.artifact;
    if (!version || !artifact) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'firmware version and artifact are required', retryable: false } };
    }
    const manifest = firmwareStore.read(version);
    if (!manifest) {
      return dispatchFailure({ code: 'RELEASE_NOT_FOUND', message: 'firmware release not found', retryable: false, clientId, deviceId: input.deviceId, operation: input.operation });
    }
    if (manifest.artifact !== artifact) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'firmware artifact does not match the release', retryable: false } };
    }
    if (managedDevice !== undefined && !manifest.deviceTypes.includes(managedDevice.deviceType)) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'firmware does not match the device type', retryable: false } };
    }
    command.firmware = {
      release: manifest.version,
      artifact: manifest.artifact,
      downloadUrl: `${publicBaseUrl}/agent/v1/releases/${encodeURIComponent(manifest.version)}/${encodeURIComponent(manifest.artifact)}?clientId=${encodeURIComponent(clientId)}`,
      sha256: manifest.sha256,
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    };
  }
  commands.set(command.commandId, { request: command, status: 'dispatched', createdAt: new Date(now).toISOString() });
  logCommandState(clientId, { commandId: command.commandId, deviceId: command.deviceId }, 'dispatched', command, undefined);
  writeAudit({
    actor: input.actor,
    clientId,
    deviceId: command.deviceId,
    commandId: command.commandId,
    action: 'command.dispatch',
    detail: { operation: command.operation, parameters: command.parameters, ...(command.firmware !== undefined ? { firmware: { release: command.firmware.release, artifact: command.firmware.artifact, sha256: command.firmware.sha256 } } : {}) },
  });
  client.socket.send(JSON.stringify(message('command.execute', command, clientId)));
  return { ok: true, commandId: command.commandId };
}

type UpdateDispatchResult = { ok: true; updateId: string; version: string } | { ok: false; error: { code: string; message: string; retryable: boolean } };

function dispatchUpdate(input: { clientId: string; version: string; actor: string }): UpdateDispatchResult {
  const client = clients.get(input.clientId);
  if (!client || client.status !== 'online' || !client.socket || client.socket.readyState !== WebSocket.OPEN) {
    return { ok: false, error: { code: 'CLIENT_OFFLINE', message: 'client is not online', retryable: true } };
  }
  const manifest = readManifest(input.version);
  if (!manifest) {
    return { ok: false, error: { code: 'RELEASE_NOT_FOUND', message: 'release not found', retryable: false } };
  }
  const updateId = `upd_${randomUUID()}`;
  writeAudit({ actor: input.actor, clientId: input.clientId, action: 'client.update.dispatch', detail: { version: manifest.version, updateId } });
  logEvent(input.clientId, 'client.update.dispatched', { version: manifest.version, updateId });
  client.socket.send(JSON.stringify(message('client.update', {
    ...manifest,
    updateId,
    downloadUrl: `${publicBaseUrl}/agent/v1/releases/${encodeURIComponent(manifest.version)}/${encodeURIComponent(manifest.artifact)}?clientId=${encodeURIComponent(input.clientId)}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, input.clientId)));
  return { ok: true, updateId, version: manifest.version };
}

const mcpContext: McpServerContext = {
  serverName: 'ttlab',
  serverVersion: '0.1.0',
  listClients: () => [...clients.values()].map(clientView),
  listDevices: () => [...clients.values()].flatMap((client) => managedDevices(client)),
  getDeviceStatus: (deviceId) => {
    for (const client of clients.values()) {
      const device = client.snapshot?.devices.find((item) => item.deviceId === deviceId) ?? client.snapshot?.managedDevices?.find((item) => item.deviceId === deviceId);
      if (device) return { ...device, clientId: client.clientId };
    }
    return undefined;
  },
  queryLogs: (options) => logStore.query(options),
  queryAudit: (options) => logStore.query({ ...options, types: ['audit'] }),
  getCommandStatus: (commandId) => {
    const command = commands.get(commandId);
    if (!command) return undefined;
    return { commandId, status: command.status, createdAt: command.createdAt, ...(command.result !== undefined ? { result: command.result } : {}) };
  },
  dispatchCommand,
  dispatchUpdate,
};
const mcpServer = new McpServer(mcpContext);

function writeAgentEntry(sessionId: string, detail: Record<string, unknown>): void {
  logStore.write({ ts: new Date().toISOString(), type: 'agent', sessionId, data: detail });
}

const agentEngine: AgentEngine = settingsStore.get().engine === 'dsh'
  ? new DshEngine({
      baseUrl: () => settingsStore.get().dshBaseUrl,
      token: () => settingsStore.get().dshToken || undefined,
      workdir: () => settingsStore.get().dshWorkdir,
      approvalTimeoutMs: () => settingsStore.get().approvalTimeoutMs,
    })
  : new ServerNativeEngineAdapter(
      new ServerNativeEngine({
        llm: new DeepSeekApiClient({
          baseUrl: () => settingsStore.get().llmUrl,
          apiKey: () => settingsStore.get().apiKey || undefined,
          model: () => settingsStore.get().model,
        }),
      }),
      () => buildSystemPrompt(settingsStore.get().model),
    );

const agentGateway = new AgentGateway({
  engine: agentEngine,
  approvals: new ApprovalManager(() => settingsStore.get().approvalTimeoutMs, (approval) => {
    writeAudit({ actor: `agent:${approval.sessionId}`, action: 'approval.timeout', detail: { approvalId: approval.approvalId, tool: approval.tool, args: approval.args } });
  }),
  mcpContext,
  maxSessions: () => settingsStore.get().maxSessions,
  logAgent: writeAgentEntry,
  auditApproval: (sessionId, approvalId, tool, decision, args) => {
    writeAudit({ actor: `agent:${sessionId}`, action: 'approval.decided', detail: { approvalId, tool, decision, args } });
    writeAgentEntry(sessionId, { role: 'approval', approvalId, tool, decision, args });
  },
});

function writeMcpResponse(request: IncomingMessage, response: import('node:http').ServerResponse, payload: string): void {
  const accept = request.headers.accept ?? '';
  if (accept.includes('text/event-stream')) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.end(`event: message\ndata: ${payload}\n\n`);
  } else {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(payload);
  }
}

async function handleMcpRequest(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
  const agentSettings = settingsStore.get();
  if (!agentSettings.enabled) {
    json(response, 404, { error: { code: 'NOT_FOUND', message: 'resource not found', retryable: false } });
    return;
  }
  if (request.method !== 'POST') {
    json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP endpoint accepts POST requests only', retryable: false } });
    return;
  }
  if (agentSettings.agentToken.length > 0) {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (bearer !== agentSettings.agentToken) {
      json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid agent token', retryable: false } });
      return;
    }
  }
  let body: unknown;
  try {
    body = await readBody(request);
  } catch (error) {
    writeMcpResponse(request, response, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'invalid request body' } }));
    return;
  }
  const result = await mcpServer.handle(body);
  if (result === null) {
    response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    response.end('{}');
    return;
  }
  writeMcpResponse(request, response, JSON.stringify(result));
}

const httpServer = tlsEnabled
  ? createHttpsServer({ key: readFileSync(tlsKeyFile as string), cert: readFileSync(tlsCertFile as string) }, requestHandler)
  : createHttpServer(requestHandler);

async function requestHandler(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  try {
    const staticFile = request.method === 'GET' ? staticFiles[url.pathname] : undefined;
    if (staticFile) {
      const filePath = `${webRoot}/${staticFile.file}`;
      if (!existsSync(filePath)) {
        json(response, 500, { error: { code: 'WEB_ASSET_MISSING', message: 'web asset is not available', retryable: false } });
        return;
      }
      response.writeHead(200, { 'content-type': staticFile.contentType, 'cache-control': 'no-cache' });
      createReadStream(filePath).pipe(response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/healthz') {
      json(response, 200, { status: 'ok', clients: clients.size, logStore: logStore.status() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/clients') {
      json(response, 200, { data: [...clients.values()].map(clientView) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/devices') {
      const devices = [...clients.values()].flatMap((client) => managedDevices(client));
      json(response, 200, { data: devices });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/logs/query') {
      try {
        const result = await logStore.query(parseLogQuery(url.searchParams));
        json(response, 200, { data: result.data, hasMore: result.hasMore, nextOffset: result.nextOffset, truncated: result.truncated });
      } catch (error) {
        json(response, 400, { error: { code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : 'invalid query', retryable: false } });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/audit') {
      try {
        const result = await logStore.query(parseAuditQuery(url.searchParams));
        json(response, 200, { data: result.data, hasMore: result.hasMore, nextOffset: result.nextOffset, truncated: result.truncated });
      } catch (error) {
        json(response, 400, { error: { code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : 'invalid query', retryable: false } });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/settings/agent') {
      json(response, 200, { data: toAgentSettingsView(settingsStore.get()) });
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/v1/settings/agent') {
      let patch: ReturnType<typeof parseAgentSettingsPatch>;
      try {
        patch = parseAgentSettingsPatch(await readBody(request));
      } catch (error) {
        json(response, 400, { error: { code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : 'invalid settings', retryable: false } });
        return;
      }
      try {
        const updated = settingsStore.update(patch);
        json(response, 200, { data: toAgentSettingsView(updated) });
      } catch (error) {
        json(response, 500, { error: { code: 'SETTINGS_PERSIST_FAILED', message: error instanceof Error ? error.message : 'cannot persist settings', retryable: true } });
      }
      return;
    }
    const releaseMatch = url.pathname.match(/^\/agent\/v1\/releases\/([^/]+)\/([^/]+)$/);
    if (request.method === 'GET' && releaseMatch) {
      const version = decodeURIComponent(releaseMatch[1] ?? '');
      const artifact = decodeURIComponent(releaseMatch[2] ?? '');
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const clientId = url.searchParams.get('clientId');
      if (!isSafeSegment(artifact) || !clientId || (clientAuthEnabled && configuredTokens.get(clientId) !== token)) {
        json(response, 404, { error: { code: 'RELEASE_NOT_FOUND', message: 'release not found', retryable: false } });
        return;
      }
      const firmwarePath = firmwareStore.artifactPath(version, artifact);
      if (firmwarePath) {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        createReadStream(firmwarePath).pipe(response);
        return;
      }
      const manifest = readManifest(version);
      const artifactPath = `${releaseDirectory}/${version}/${artifact}`;
      if (!manifest || !existsSync(artifactPath) || manifest.artifact !== artifact) {
        json(response, 404, { error: { code: 'RELEASE_NOT_FOUND', message: 'release not found', retryable: false } });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      createReadStream(artifactPath).pipe(response);
      return;
    }
    const firmwareUploadMatch = url.pathname.match(/^\/api\/v1\/firmware\/releases\/([^/]+)$/);
    if (request.method === 'POST' && firmwareUploadMatch) {
      const version = decodeURIComponent(firmwareUploadMatch[1] ?? '');
      const artifact = url.searchParams.get('artifact');
      const description = url.searchParams.get('description') ?? undefined;
      const deviceTypes = [...new Set(url.searchParams.getAll('deviceType').map((value) => value.trim()).filter(Boolean))];
      const invalidDeviceType = deviceTypes.find((value) => !isSafeSegment(value));
      if (!artifact) {
        json(response, 400, { error: { code: 'INVALID_ARGUMENT', message: 'artifact query parameter is required', retryable: false } });
        return;
      }
      if (invalidDeviceType !== undefined) {
        json(response, 400, { error: { code: 'INVALID_ARGUMENT', message: `invalid deviceType "${invalidDeviceType}"`, retryable: false } });
        return;
      }
      try {
        const manifest = await firmwareStore.publish({
          version,
          artifact,
          ...(description !== undefined ? { description } : {}),
          ...(deviceTypes.length > 0 ? { deviceTypes } : {}),
          body: request,
        });
        writeAudit({ actor: 'anonymous', action: 'firmware.release.published', detail: { version: manifest.version, artifact: manifest.artifact, sha256: manifest.sha256, size: manifest.size, deviceTypes: manifest.deviceTypes } });
        json(response, 201, { data: manifest });
      } catch (error) {
        if (error instanceof FirmwareStoreError) {
          const status = error.code === 'ALREADY_EXISTS' ? 409 : error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
          json(response, status, { error: { code: error.code, message: error.message, retryable: error.retryable } });
          return;
        }
        json(response, 400, { error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'invalid request', retryable: false } });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/firmware/releases') {
      json(response, 200, { data: firmwareStore.list() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/device-types') {
      json(response, 200, { data: listDeviceCategories() });
      return;
    }
    const commandMatch = url.pathname.match(/^\/api\/v1\/clients\/([^/]+)\/commands$/);
    if (request.method === 'POST' && commandMatch) {
      const clientId = decodeURIComponent(commandMatch[1] ?? '');
      const client = clients.get(clientId);
      if (!client || client.status !== 'online' || !client.socket || client.socket.readyState !== WebSocket.OPEN) {
        json(response, 409, { error: { code: 'CLIENT_OFFLINE', message: 'client is not online', retryable: true } });
        return;
      }
      const body = await readBody(request) as Record<string, unknown>;
      if (typeof body.deviceId !== 'string' || typeof body.operation !== 'string' || !body.parameters || typeof body.parameters !== 'object') {
        json(response, 400, { error: { code: 'INVALID_ARGUMENT', message: 'deviceId, operation and parameters are required', retryable: false } });
        return;
      }
      const result = dispatchCommand({ clientId, deviceId: body.deviceId, operation: body.operation, parameters: body.parameters as Record<string, string>, actor: 'anonymous' });
      if (!result.ok) {
        json(response, result.error.code === 'CLIENT_OFFLINE' || result.error.code === 'DEVICE_OFFLINE' ? 409 : 400, { error: result.error });
        return;
      }
      json(response, 202, { data: { commandId: result.commandId, status: 'dispatched' } });
      return;
    }
    const commandStatusMatch = url.pathname.match(/^\/api\/v1\/commands\/([^/]+)$/);
    if (request.method === 'GET' && commandStatusMatch) {
      const commandId = decodeURIComponent(commandStatusMatch[1] ?? '');
      const command = commands.get(commandId);
      if (!command) {
        json(response, 404, { error: { code: 'COMMAND_NOT_FOUND', message: 'command not found', retryable: false } });
        return;
      }
      json(response, 200, { data: { commandId, status: command.status, createdAt: command.createdAt, progress: command.progress, result: command.result } });
      return;
    }
    const updateMatch = url.pathname.match(/^\/api\/v1\/clients\/([^/]+)\/update$/);
    if (request.method === 'POST' && updateMatch) {
      const clientId = decodeURIComponent(updateMatch[1] ?? '');
      const client = clients.get(clientId);
      if (!client || client.status !== 'online' || !client.socket || client.socket.readyState !== WebSocket.OPEN) {
        json(response, 409, { error: { code: 'CLIENT_OFFLINE', message: 'client is not online', retryable: true } });
        return;
      }
      const body = await readBody(request) as Record<string, unknown>;
      if (typeof body.version !== 'string') {
        json(response, 400, { error: { code: 'INVALID_ARGUMENT', message: 'version is required', retryable: false } });
        return;
      }
      const result = dispatchUpdate({ clientId, version: body.version, actor: 'anonymous' });
      if (!result.ok) {
        json(response, result.error.code === 'CLIENT_OFFLINE' ? 409 : 404, { error: result.error });
        return;
      }
      json(response, 202, { data: { updateId: result.updateId, version: result.version, status: 'dispatched' } });
      return;
    }
    if (url.pathname === '/mcp/v1') {
      await handleMcpRequest(request, response);
      return;
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: 'resource not found', retryable: false } });
  } catch (error) {
    logError({ code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'invalid request' });
    json(response, 400, { error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'invalid request', retryable: false } });
  }
}

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/v1/events') {
    webEventServer.handleUpgrade(request, socket, head, (websocket) => webEventServer.emit('connection', websocket, request));
    return;
  }
  if (url.pathname === '/api/v1/agent/session') {
    if (!settingsStore.get().enabled) {
      socket.destroy();
      return;
    }
    agentSocketServer.handleUpgrade(request, socket, head, (websocket) => agentSocketServer.emit('connection', websocket, request));
    return;
  }
  if (url.pathname !== '/agent/v1/session') {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit('connection', websocket, request));
});
agentGateway.attachServer(agentSocketServer);

websocketServer.on('connection', (socket, request: IncomingMessage) => {
  let boundClientId: string | undefined;
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  socket.on('message', (data) => {
    try {
      const envelope = parseEnvelope(data.toString()) as Envelope;
      if (envelope.type === 'client.hello') {
        const hello = parseClientHello(envelope.payload);
        const clientId = envelope.clientId;
        if (!clientId || (clientAuthEnabled && (!configuredTokens.has(clientId) || configuredTokens.get(clientId) !== token))) {
          socket.close(1008, 'client authentication failed');
          return;
        }
        const previous = clients.get(clientId);
        // 同一 clientId 已被另一个仍在线的进程实例（bootId 不同）占用时，拒绝新连接，
        // 避免多个实例反复互相抢占会话导致设备状态抖动。
        const previousAlive = previous !== undefined && previous.status === 'online' && previous.socket !== undefined && previous.socket.readyState === WebSocket.OPEN;
        if (previousAlive && previous.hello?.bootId !== undefined && previous.hello.bootId !== hello.bootId) {
          logEvent(clientId, 'client.duplicate_rejected', { bootId: hello.bootId, existingBootId: previous.hello.bootId });
          socket.close(4009, 'duplicate client id registered by another instance');
          return;
        }
        boundClientId = clientId;
        previous?.socket?.close(4001, 'replaced by newer connection');
        // 同一 bootId 重连时携带上一连接快照，避免重连被误判为整批设备重新发现
        const runtime: RuntimeClient = {
          clientId,
          status: 'syncing',
          socket,
          hello,
          connectedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          ...(previous?.snapshot?.bootId === hello.bootId && previous.snapshot !== undefined ? { snapshot: previous.snapshot } : {}),
        };
        clients.set(clientId, runtime);
        logEvent(clientId, 'client.connected', { bootId: hello.bootId, version: hello.clientVersion, ...(hello.hostname !== undefined ? { hostname: hello.hostname } : {}) });
        socket.send(JSON.stringify(message('sync.request', { reason: 'connection_established' }, clientId, envelope.id)));
        return;
      }
      if (!boundClientId || envelope.clientId !== boundClientId) throw new Error('client is not authenticated');
      const runtime = clients.get(boundClientId);
      if (!runtime || runtime.socket !== socket) throw new Error('stale client connection');
      if (envelope.type === 'client.snapshot') {
        const nextSnapshot = parseClientSnapshot(envelope.payload);
        if (runtime.snapshot && runtime.snapshot.bootId === nextSnapshot.bootId && nextSnapshot.snapshotRevision <= runtime.snapshot.snapshotRevision) return;
        const wasOnline = runtime.status === 'online';
        const previousSnapshot = runtime.snapshot;
        runtime.snapshot = nextSnapshot;
        runtime.status = 'online';
        runtime.lastHeartbeatAt = new Date().toISOString();
        if (!wasOnline) {
          logEvent(boundClientId, 'client.online', {
            bootId: nextSnapshot.bootId,
            revision: nextSnapshot.snapshotRevision,
            devices: nextSnapshot.devices.length,
            ...(nextSnapshot.managedDevices !== undefined ? { managedDevices: nextSnapshot.managedDevices.length } : {}),
          });
        }
        diffAndLogDeviceEvents(boundClientId, previousSnapshot, nextSnapshot);
        broadcastState(runtime);
      } else if (envelope.type === 'client.heartbeat') {
        runtime.lastHeartbeatAt = new Date().toISOString();
      } else if (envelope.type === 'command.accepted' || envelope.type === 'command.progress' || envelope.type === 'command.result' || envelope.type === 'command.failed') {
        const payload = envelope.payload as { commandId?: string; deviceId?: string };
        const command = payload.commandId ? commands.get(payload.commandId) : undefined;
        let result: unknown;
        if (command) {
          command.status = envelope.type.slice('command.'.length);
          if (envelope.type === 'command.progress') {
            command.progress = parseCommandProgress(envelope.payload);
            broadcastState(runtime);
          }
          if (envelope.type === 'command.result' || envelope.type === 'command.failed') {
            command.result = parseCommandResult(envelope.payload);
            result = command.result;
          }
        }
        logCommandState(boundClientId, payload, envelope.type.slice('command.'.length), command?.request, result);
        if (runtime.snapshot) broadcastState(runtime);
      } else if (envelope.type === 'update.progress' || envelope.type === 'update.completed' || envelope.type === 'update.failed') {
        logEvent(boundClientId, `client.update.${envelope.type.slice('update.'.length)}`, envelope.payload as Record<string, unknown>);
      } else if (envelope.type === 'device.log.chunk') {
        const chunk = parseDeviceLogChunk(envelope.payload);
        broadcastLog(chunk, boundClientId);
        logDeviceChunk(boundClientId, chunk);
      }
    } catch (error) {
      logError({ code: 'PROTOCOL_ERROR', message: error instanceof Error ? error.message : 'invalid message', ...(boundClientId !== undefined ? { clientId: boundClientId } : {}) });
      socket.send(JSON.stringify(message('command.failed', { commandId: '', error: { code: 'PROTOCOL_ERROR', message: error instanceof Error ? error.message : 'invalid message', retryable: false } })));
    }
  });
  socket.on('close', () => {
    if (!boundClientId) return;
    const runtime = clients.get(boundClientId);
    if (runtime?.socket === socket) {
      const alreadyOffline = runtime.status === 'offline';
      runtime.socket = undefined;
      runtime.status = 'offline';
      logEvent(boundClientId, 'client.disconnected');
      if (!alreadyOffline) logDevicesOffline(boundClientId, runtime.snapshot);
      broadcastState(runtime);
    }
  });
});

webEventServer.on('connection', (socket) => {
  for (const runtime of clients.values()) {
    if (runtime.snapshot) socket.send(JSON.stringify(message('client.snapshot', runtime.snapshot, runtime.clientId)));
  }
  webLogSubscriptions.attach(socket);
});

setInterval(() => {
  const deadline = Date.now() - heartbeatTimeoutMs;
  for (const runtime of clients.values()) {
    if (runtime.lastHeartbeatAt && Date.parse(runtime.lastHeartbeatAt) < deadline) {
      runtime.status = 'offline';
      logEvent(runtime.clientId, 'client.heartbeat_timeout');
      logDevicesOffline(runtime.clientId, runtime.snapshot);
      runtime.socket?.close(4000, 'heartbeat timeout');
    }
  }
}, Math.max(1000, Math.floor(heartbeatTimeoutMs / 2))).unref();

httpServer.listen(port, () => {
  logEvent(undefined, 'server.started', { port, tls: tlsEnabled });
  console.log(JSON.stringify({ event: 'server_started', port, tls: tlsEnabled }));
});

function shutdownServer(): void {
  logEvent(undefined, 'server.stopping', {});
  for (const client of clients.values()) client.socket?.close(1001, 'server shutting down');
  for (const socket of websocketServer.clients) socket.close(1001, 'server shutting down');
  for (const socket of webEventServer.clients) socket.close(1001, 'server shutting down');
  agentGateway.close();
  for (const socket of agentSocketServer.clients) socket.close(1001, 'server shutting down');
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  httpServer.close(() => {
    void logStore.close().then(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdownServer);
}
