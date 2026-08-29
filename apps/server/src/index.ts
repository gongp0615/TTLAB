import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  message,
  parseClientHello,
  parseClientSnapshot,
  parseCommandResult,
  parseEnvelope,
  type ClientHello,
  type ClientSnapshot,
  type CommandRequest,
  type Envelope,
  type UpdateManifest,
} from '../../../packages/protocol/src/index.js';

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

const port = Number(process.env.TTLAB_SERVER_PORT ?? 80);
const heartbeatTimeoutMs = Number(process.env.TTLAB_HEARTBEAT_TIMEOUT_MS ?? 30_000);
const configuredTokens = parseTokens(process.env.TTLAB_CLIENT_TOKENS ?? '');
const clientAuthEnabled = process.env.TTLAB_CLIENT_AUTH_ENABLED === '1';
const releaseDirectory = process.env.TTLAB_RELEASE_DIR ?? './releases';
const tlsKeyFile = process.env.TTLAB_TLS_KEY_FILE;
const tlsCertFile = process.env.TTLAB_TLS_CERT_FILE;
const tlsRequired = process.env.TTLAB_TLS_REQUIRED === '1';
if ((tlsKeyFile && !tlsCertFile) || (!tlsKeyFile && tlsCertFile)) throw new Error('TTLAB_TLS_KEY_FILE and TTLAB_TLS_CERT_FILE must be configured together');
if (tlsRequired && (!tlsKeyFile || !tlsCertFile)) throw new Error('TLS is required but certificate files are not configured');
const tlsEnabled = Boolean(tlsKeyFile && tlsCertFile);
const publicBaseUrl = process.env.TTLAB_PUBLIC_BASE_URL ?? `${tlsEnabled ? 'https' : 'http'}://127.0.0.1:${port}`;
const webRoot = process.env.TTLAB_WEB_ROOT ?? '.';
const supportedOperations = new Set([
  'hdmi.switch', 'hdmi.status', 'usb.path', 'usb.status', 'system.ping', 'system.version',
  'system.reset', 'device.reboot', 'hardware.rgb', 'hardware.lcd',
]);

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
const commands = new Map<string, { request: CommandRequest; status: string; createdAt: string; result?: unknown }>();
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const webEventServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
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

function broadcastState(client: RuntimeClient): void {
  if (!client.snapshot) return;
  const event = JSON.stringify(message('client.snapshot', client.snapshot, client.clientId));
  for (const viewer of webEventServer.clients) {
    if (viewer.readyState === WebSocket.OPEN) viewer.send(event);
  }
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
      json(response, 200, { status: 'ok', clients: clients.size });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/clients') {
      json(response, 200, { data: [...clients.values()].map(clientView) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/devices') {
      const devices = [...clients.values()].flatMap((client) => client.snapshot?.devices.map((device) => ({ ...device, clientId: client.clientId })) ?? []);
      json(response, 200, { data: devices });
      return;
    }
    const releaseMatch = url.pathname.match(/^\/agent\/v1\/releases\/([^/]+)\/([^/]+)$/);
    if (request.method === 'GET' && releaseMatch) {
      const version = decodeURIComponent(releaseMatch[1] ?? '');
      const artifact = decodeURIComponent(releaseMatch[2] ?? '');
      const manifest = readManifest(version);
      const artifactPath = `${releaseDirectory}/${version}/${artifact}`;
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      const clientId = url.searchParams.get('clientId');
      if (!isSafeSegment(artifact) || !manifest || !existsSync(artifactPath) || manifest.artifact !== artifact || !clientId || (clientAuthEnabled && configuredTokens.get(clientId) !== token)) {
        json(response, 404, { error: { code: 'RELEASE_NOT_FOUND', message: 'release not found', retryable: false } });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      createReadStream(artifactPath).pipe(response);
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
      if (!supportedOperations.has(body.operation)) {
        json(response, 400, { error: { code: 'UNSUPPORTED_OPERATION', message: 'operation is not enabled', retryable: false } });
        return;
      }
      if (![...Object.values(body.parameters as Record<string, unknown>)].every((value) => typeof value === 'string' && value.length <= 128)) {
        json(response, 400, { error: { code: 'INVALID_ARGUMENT', message: 'command parameters must be short strings', retryable: false } });
        return;
      }
      if (!client.snapshot?.devices.some((device) => device.deviceId === body.deviceId)) {
        json(response, 409, { error: { code: 'DEVICE_OFFLINE', message: 'device is not in the client snapshot', retryable: true } });
        return;
      }
      const now = Date.now();
      const command: CommandRequest = {
        commandId: `cmd_${randomUUID()}`,
        deviceId: body.deviceId,
        operation: body.operation,
        parameters: body.parameters as Record<string, string>,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString(),
      };
      commands.set(command.commandId, { request: command, status: 'dispatched', createdAt: new Date(now).toISOString() });
      client.socket.send(JSON.stringify(message('command.execute', command, clientId)));
      json(response, 202, { data: { commandId: command.commandId, status: 'dispatched' } });
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
      json(response, 200, { data: { commandId, status: command.status, createdAt: command.createdAt, result: command.result } });
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
      const manifest = readManifest(body.version);
      if (!manifest) {
        json(response, 404, { error: { code: 'RELEASE_NOT_FOUND', message: 'release not found', retryable: false } });
        return;
      }
      const updateId = `upd_${randomUUID()}`;
      client.socket.send(JSON.stringify(message('client.update', {
        ...manifest,
        updateId,
        downloadUrl: `${publicBaseUrl}/agent/v1/releases/${encodeURIComponent(manifest.version)}/${encodeURIComponent(manifest.artifact)}?clientId=${encodeURIComponent(clientId)}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }, clientId)));
      json(response, 202, { data: { updateId, version: manifest.version, status: 'dispatched' } });
      return;
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: 'resource not found', retryable: false } });
  } catch (error) {
    json(response, 400, { error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'invalid request', retryable: false } });
  }
}

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/v1/events') {
    webEventServer.handleUpgrade(request, socket, head, (websocket) => webEventServer.emit('connection', websocket, request));
    return;
  }
  if (url.pathname !== '/agent/v1/session') {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit('connection', websocket, request));
});

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
        boundClientId = clientId;
        const previous = clients.get(clientId);
        previous?.socket?.close(4001, 'replaced by newer connection');
        const runtime: RuntimeClient = { clientId, status: 'syncing', socket, hello, connectedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString() };
        clients.set(clientId, runtime);
        socket.send(JSON.stringify(message('sync.request', { reason: 'connection_established' }, clientId, envelope.id)));
        return;
      }
      if (!boundClientId || envelope.clientId !== boundClientId) throw new Error('client is not authenticated');
      const runtime = clients.get(boundClientId);
      if (!runtime || runtime.socket !== socket) throw new Error('stale client connection');
      if (envelope.type === 'client.snapshot') {
        const nextSnapshot = parseClientSnapshot(envelope.payload);
        if (runtime.snapshot && runtime.snapshot.bootId === nextSnapshot.bootId && nextSnapshot.snapshotRevision <= runtime.snapshot.snapshotRevision) return;
        runtime.snapshot = nextSnapshot;
        runtime.status = 'online';
        runtime.lastHeartbeatAt = new Date().toISOString();
        broadcastState(runtime);
      } else if (envelope.type === 'client.heartbeat') {
        runtime.lastHeartbeatAt = new Date().toISOString();
      } else if (envelope.type === 'command.accepted' || envelope.type === 'command.progress' || envelope.type === 'command.result' || envelope.type === 'command.failed') {
        const payload = envelope.payload as { commandId?: string };
        const command = payload.commandId ? commands.get(payload.commandId) : undefined;
        if (command) {
          command.status = envelope.type.slice('command.'.length);
          if (envelope.type === 'command.result' || envelope.type === 'command.failed') command.result = parseCommandResult(envelope.payload);
        }
        if (runtime.snapshot) broadcastState(runtime);
      }
    } catch (error) {
      socket.send(JSON.stringify(message('command.failed', { commandId: '', error: { code: 'PROTOCOL_ERROR', message: error instanceof Error ? error.message : 'invalid message', retryable: false } })));
    }
  });
  socket.on('close', () => {
    if (!boundClientId) return;
    const runtime = clients.get(boundClientId);
    if (runtime?.socket === socket) {
      runtime.socket = undefined;
      runtime.status = 'offline';
      broadcastState(runtime);
    }
  });
});

webEventServer.on('connection', (socket) => {
  for (const runtime of clients.values()) {
    if (runtime.snapshot) socket.send(JSON.stringify(message('client.snapshot', runtime.snapshot, runtime.clientId)));
  }
});

setInterval(() => {
  const deadline = Date.now() - heartbeatTimeoutMs;
  for (const runtime of clients.values()) {
    if (runtime.lastHeartbeatAt && Date.parse(runtime.lastHeartbeatAt) < deadline) {
      runtime.status = 'offline';
      runtime.socket?.close(4000, 'heartbeat timeout');
    }
  }
}, Math.max(1000, Math.floor(heartbeatTimeoutMs / 2))).unref();

httpServer.listen(port, () => console.log(JSON.stringify({ event: 'server_started', port, tls: tlsEnabled })));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const client of clients.values()) client.socket?.close(1001, 'server shutting down');
    httpServer.close(() => process.exit(0));
  });
}
