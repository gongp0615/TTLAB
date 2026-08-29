import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { createConnection } from 'node:net';
import { WebSocket } from 'ws';
import { message, parseCommandRequest, parseEnvelope, type ClientSnapshot, type UpdateRequest } from '../../../packages/protocol/src/index.js';
import { TvStickTestBoxAdapter } from './serial.js';
import { DeviceCommandExecutor } from './executor.js';
import { DeviceManager } from './device-manager.js';

const serverUrl = process.env.TTLAB_SERVER_URL ?? 'ws://127.0.0.1/agent/v1/session';
const token = process.env.TTLAB_CLIENT_TOKEN?.trim() || undefined;
const clientAuthEnabled = process.env.TTLAB_CLIENT_AUTH_ENABLED === '1';
const stateDirectory = process.env.TTLAB_STATE_DIR ?? '/var/lib/ttlab-client';
const configuredClientId = process.env.TTLAB_CLIENT_ID?.trim() || undefined;
const clientVersion = process.env.TTLAB_CLIENT_VERSION ?? '0.1.0';
const heartbeatMs = Number(process.env.TTLAB_HEARTBEAT_MS ?? 10_000);
const updaterSocket = process.env.TTLAB_UPDATER_SOCKET ?? '/run/ttlab-updater/update.sock';
const tvStickAdapter = new TvStickTestBoxAdapter(Number(process.env.TTLAB_SERIAL_TIMEOUT_MS ?? 3000));

if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ event: 'client_self_check', status: 'ok', protocolVersion: '1.0', platform: platform(), architecture: arch() }));
  process.exit(0);
}

if (clientAuthEnabled && !token) throw new Error('TTLAB_CLIENT_TOKEN is required when client authentication is enabled');

mkdirSync(stateDirectory, { recursive: true, mode: 0o750 });
const clientIdPath = `${stateDirectory}/client-id`;
const clientId = configuredClientId ?? (existsSync(clientIdPath) ? readFileSync(clientIdPath, 'utf8').trim() : `client-${randomUUID()}`);
if (!existsSync(clientIdPath)) writeFileSync(clientIdPath, `${clientId}\n`, { mode: 0o640 });

const bootId = `boot-${randomUUID()}`;
let snapshotRevision = 0;
let socket: WebSocket | undefined;
let reconnectDelay = 1000;
let heartbeatTimer: NodeJS.Timeout | undefined;
const commandExecutor = new DeviceCommandExecutor();
let reconnectTimer: NodeJS.Timeout | undefined;

const deviceManager = new DeviceManager({
  stateDirectory,
  controlSelector: process.env.TTLAB_TVBOX_CONTROL_PORT,
  logSelector: process.env.TTLAB_TVBOX_LOG_PORT,
  probeEnabled: process.env.TTLAB_TVBOX_PROBE !== '0',
  onLog: (chunk) => send('device.log.chunk', chunk),
  onLogError: (port, error) => console.error(JSON.stringify({ event: 'serial_log_error', portId: port.deviceId, message: error.message })),
});

function snapshot(): ClientSnapshot {
  snapshotRevision += 1;
  const updateStatus = readUpdateStatus();
  return {
    snapshotRevision,
    clientVersion,
    bootId,
    health: 'healthy',
    devices: deviceManager.serialPorts,
    managedDevices: deviceManager.managedDevices,
    ...(commandExecutor.activeCommandIds[0] ? { activeCommandId: commandExecutor.activeCommandIds[0] } : {}),
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

async function refreshDevices(sendSnapshot: boolean): Promise<void> {
  const changed = await deviceManager.refresh();
  if (changed && sendSnapshot) send('client.snapshot', snapshot());
}

function connect(): void {
  socket = new WebSocket(serverUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  socket.on('open', () => {
    reconnectDelay = 1000;
    send('client.hello', { clientVersion, protocolVersion: '1.0', bootId, platform: platform(), architecture: arch(), capabilities: ['serial'] });
    heartbeatTimer = setInterval(() => send('client.heartbeat', { bootId, clientVersion, snapshotRevision, health: 'healthy' }), heartbeatMs);
  });
  socket.on('message', (data) => {
    try {
      const envelope = parseEnvelope(data.toString());
      if (envelope.type === 'sync.request') void refreshDevices(false).then(() => send('client.snapshot', snapshot(), envelope.id));
      if (envelope.type === 'client.update') startUpdate(envelope.payload as UpdateRequest, envelope.id);
      if (envelope.type === 'command.execute') {
        void executeCommand(parseCommandRequest(envelope.payload), envelope.id);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'protocol_error', message: error instanceof Error ? error.message : 'invalid message' }));
    }
  });
  socket.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, reconnectDelay + Math.floor(Math.random() * 500));
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
  socket.on('error', (error) => console.error(JSON.stringify({ event: 'client_socket_error', message: error.message })));
}

async function executeCommand(raw: ReturnType<typeof parseCommandRequest>, correlationId: string): Promise<void> {
  const expiresAt = Date.parse(raw.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    send('command.failed', { commandId: raw.commandId, deviceId: raw.deviceId, error: { code: 'COMMAND_EXPIRED', message: 'command has expired', retryable: false } }, correlationId);
    return;
  }
  const target = deviceManager.resolveCommandTarget(raw.deviceId);
  if (!target) {
    send('command.failed', { commandId: raw.commandId, deviceId: raw.deviceId, error: { code: 'DEVICE_OFFLINE', message: 'device is not identified or has no control port', retryable: true } }, correlationId);
    return;
  }
  if (commandExecutor.isBusy(raw.deviceId)) {
    send('command.failed', { commandId: raw.commandId, deviceId: raw.deviceId, error: { code: 'SERIAL_BUSY', message: 'another serial command is running for this device', retryable: true } }, correlationId);
    return;
  }
  send('command.accepted', { commandId: raw.commandId, deviceId: raw.deviceId }, correlationId);
  const result = await commandExecutor.execute(raw, { ...target.port, deviceId: raw.deviceId }, tvStickAdapter);
  send(result.success ? 'command.result' : 'command.failed', result, correlationId);
  send('client.snapshot', snapshot());
}

function startUpdate(request: UpdateRequest, correlationId: string): void {
  send('update.progress', { updateId: request.updateId, version: request.version, state: 'downloading', progress: 0 }, correlationId);
  const updaterRequest = { ...request, ...(token ? { downloadToken: token } : {}) };
  const updater = createConnection(updaterSocket);
  updater.once('connect', () => updater.end(`${JSON.stringify(updaterRequest)}\n`));
  updater.once('error', (error) => {
    send('update.failed', { updateId: request.updateId, version: request.version, code: 'UPDATER_UNAVAILABLE', message: error.message }, correlationId);
  });
}

console.log(JSON.stringify({ event: 'client_started', clientId, version: clientVersion }));
connect();
setInterval(() => { void refreshDevices(true); }, 5_000).unref();
