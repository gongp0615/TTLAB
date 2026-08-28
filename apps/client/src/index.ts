import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { createConnection } from 'node:net';
import { WebSocket } from 'ws';
import { message, parseEnvelope, type ClientSnapshot, type SerialDevice, type UpdateRequest } from '../../../packages/protocol/src/index.js';
import { TvStickTestBoxAdapter, type SerialAdapter } from './serial.js';

const serverUrl = process.env.TTLAB_SERVER_URL ?? 'ws://127.0.0.1:8080/agent/v1/session';
const token = process.env.TTLAB_CLIENT_TOKEN;
const stateDirectory = process.env.TTLAB_STATE_DIR ?? '/var/lib/ttlab-client';
const configuredClientId = process.env.TTLAB_CLIENT_ID;
const clientVersion = process.env.TTLAB_CLIENT_VERSION ?? '0.1.0';
const heartbeatMs = Number(process.env.TTLAB_HEARTBEAT_MS ?? 10_000);
const updaterSocket = process.env.TTLAB_UPDATER_SOCKET ?? '/run/ttlab-updater/update.sock';
const serialDeviceType = process.env.TTLAB_SERIAL_DEVICE_TYPE ?? 'generic-serial';
const serialAdapter: SerialAdapter | undefined = serialDeviceType === 'tv-stick-test-box' ? new TvStickTestBoxAdapter(Number(process.env.TTLAB_SERIAL_TIMEOUT_MS ?? 3000)) : undefined;

if (!token) throw new Error('TTLAB_CLIENT_TOKEN is required');

mkdirSync(stateDirectory, { recursive: true, mode: 0o750 });
const clientIdPath = `${stateDirectory}/client-id`;
const clientId = configuredClientId ?? (existsSync(clientIdPath) ? readFileSync(clientIdPath, 'utf8').trim() : `client-${randomUUID()}`);
if (!existsSync(clientIdPath)) writeFileSync(clientIdPath, `${clientId}\n`, { mode: 0o640 });

const bootId = `boot-${randomUUID()}`;
let snapshotRevision = 0;
let socket: WebSocket | undefined;
let reconnectDelay = 1000;
let heartbeatTimer: NodeJS.Timeout | undefined;
let activeCommandId: string | undefined;

function discoverSerialDevices(): SerialDevice[] {
  const observedAt = new Date().toISOString();
  const byIdDirectory = '/dev/serial/by-id';
  if (existsSync(byIdDirectory)) {
    return readdirSync(byIdDirectory).sort().flatMap((entry) => {
      try {
        return [{
          deviceId: `serial:${entry}`,
          path: realpathSync(`${byIdDirectory}/${entry}`),
          stableIdentity: true,
          deviceType: serialDeviceType,
          status: 'available' as const,
          observedAt,
        }];
      } catch {
        return [];
      }
    });
  }
  const deviceDirectory = '/dev';
  if (!existsSync(deviceDirectory)) return [];
  return readdirSync(deviceDirectory).filter((entry) => /^(ttyUSB|ttyACM)\d+$/.test(entry)).sort().map((entry) => ({
    deviceId: `path:/dev/${entry}`,
    path: `/dev/${entry}`,
    stableIdentity: false,
    deviceType: serialDeviceType,
    status: 'available',
    observedAt,
  }));
}

function snapshot(): ClientSnapshot {
  snapshotRevision += 1;
  const updateStatus = readUpdateStatus();
  return {
    snapshotRevision,
    clientVersion,
    bootId,
    health: 'healthy',
    devices: discoverSerialDevices(),
    ...(activeCommandId ? { activeCommandId } : {}),
    ...(updateStatus ? { updateStatus } : {}),
  };
}

function readUpdateStatus(): ClientSnapshot['updateStatus'] {
  const statusPath = `${stateDirectory}/update-status.json`;
  if (!existsSync(statusPath)) return { state: 'idle', version: clientVersion };
  try {
    const value = JSON.parse(readFileSync(statusPath, 'utf8')) as ClientSnapshot['updateStatus'];
    return value?.state ? value : { state: 'idle', version: clientVersion };
  } catch {
    return { state: 'failed', version: clientVersion, message: 'unable to read update status' };
  }
}

function send(type: Parameters<typeof message>[0], payload: unknown, correlationId?: string): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message(type, payload, clientId, correlationId)));
}

function connect(): void {
  socket = new WebSocket(serverUrl, { headers: { Authorization: `Bearer ${token}` } });
  socket.on('open', () => {
    reconnectDelay = 1000;
    send('client.hello', { clientVersion, protocolVersion: '1.0', bootId, platform: platform(), architecture: arch(), capabilities: ['serial'] });
    heartbeatTimer = setInterval(() => send('client.heartbeat', { bootId, clientVersion, snapshotRevision, health: 'healthy' }), heartbeatMs);
  });
  socket.on('message', (data) => {
    try {
      const envelope = parseEnvelope(data.toString());
      if (envelope.type === 'sync.request') send('client.snapshot', snapshot(), envelope.id);
      if (envelope.type === 'client.update') startUpdate(envelope.payload as UpdateRequest, envelope.id);
      if (envelope.type === 'command.execute') {
        void executeCommand(envelope.payload as { commandId?: string; deviceId?: string; operation?: string; parameters?: Record<string, string>; issuedAt?: string; expiresAt?: string }, envelope.id);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'protocol_error', message: error instanceof Error ? error.message : 'invalid message' }));
    }
  });
  socket.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    setTimeout(connect, reconnectDelay + Math.floor(Math.random() * 500));
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
  socket.on('error', (error) => console.error(JSON.stringify({ event: 'client_socket_error', message: error.message })));
}

async function executeCommand(raw: { commandId?: string; deviceId?: string; operation?: string; parameters?: Record<string, string>; issuedAt?: string; expiresAt?: string }, correlationId: string): Promise<void> {
  const commandId = raw.commandId ?? '';
  if (!serialAdapter || !commandId || !raw.deviceId || !raw.operation || !raw.parameters || !raw.issuedAt || !raw.expiresAt) {
    send('command.failed', { commandId, error: { code: 'INVALID_ARGUMENT', message: 'invalid command payload or serial adapter is not configured', retryable: false } }, correlationId);
    return;
  }
  const expiresAt = Date.parse(raw.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    send('command.failed', { commandId, error: { code: 'COMMAND_EXPIRED', message: 'command has expired', retryable: false } }, correlationId);
    return;
  }
  const device = discoverSerialDevices().find((candidate) => candidate.deviceId === raw.deviceId);
  if (!device) {
    send('command.failed', { commandId, deviceId: raw.deviceId, error: { code: 'DEVICE_OFFLINE', message: 'device is not currently discovered', retryable: true } }, correlationId);
    return;
  }
  if (activeCommandId) {
    send('command.failed', { commandId, deviceId: raw.deviceId, error: { code: 'SERIAL_BUSY', message: 'another serial command is running', retryable: true } }, correlationId);
    return;
  }
  activeCommandId = commandId;
  send('command.accepted', { commandId, deviceId: raw.deviceId }, correlationId);
  try {
    const result = await serialAdapter.execute({ commandId, deviceId: raw.deviceId, operation: raw.operation, parameters: raw.parameters, issuedAt: raw.issuedAt, expiresAt: raw.expiresAt }, device);
    send(result.success ? 'command.result' : 'command.failed', result, correlationId);
  } catch (error) {
    send('command.failed', { commandId, deviceId: raw.deviceId, error: { code: 'SERIAL_ERROR', message: error instanceof Error ? error.message : 'serial command failed', retryable: true } }, correlationId);
  } finally {
    activeCommandId = undefined;
  }
}

function startUpdate(request: UpdateRequest, correlationId: string): void {
  send('update.progress', { updateId: request.updateId, version: request.version, state: 'downloading', progress: 0 }, correlationId);
  const updaterRequest = { ...request, downloadToken: token };
  const updater = createConnection(updaterSocket);
  updater.once('connect', () => updater.end(`${JSON.stringify(updaterRequest)}\n`));
  updater.once('error', (error) => {
    send('update.failed', { updateId: request.updateId, version: request.version, code: 'UPDATER_UNAVAILABLE', message: error.message }, correlationId);
  });
}

console.log(JSON.stringify({ event: 'client_started', clientId, version: clientVersion }));
connect();
