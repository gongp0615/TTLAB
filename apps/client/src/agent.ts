import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { arch, hostname as osHostname, networkInterfaces, platform } from 'node:os';
import { WebSocket } from 'ws';
import {
  message,
  parseCommandRequest,
  parseEnvelope,
  type ClientSnapshot,
  type CommandRequest,
  type DeviceLogChunk,
  type MessageType,
  type SerialDevice,
  type UpdateRequest,
} from '../../../packages/protocol/src/index.js';
import { TvStickTestBoxAdapter, type SerialAdapter } from './serial.js';
import { DeviceCommandExecutor } from './executor.js';
import { DeviceManager } from './device-manager.js';
import type { SerialPortInfo } from './discovery.js';

function collectAddresses(): string[] {
  const entries = Object.values(networkInterfaces()).flatMap((list) => list ?? []);
  return entries
    .filter((entry) => !entry.internal)
    .sort((a, b) => (a.family === 'IPv4' ? -1 : 1))
    .map((entry) => entry.address);
}

export interface ClientAgentOptions {
  serverUrl: string;
  stateDirectory: string;
  clientId?: string | undefined;
  token?: string | undefined;
  clientVersion?: string | undefined;
  heartbeatMs?: number | undefined;
  refreshIntervalMs?: number | undefined;
  serialTimeoutMs?: number | undefined;
  controlSelector?: string | undefined;
  logSelector?: string | undefined;
  probeEnabled?: boolean | undefined;
  adapter?: SerialAdapter | undefined;
  discoverPorts?: (() => SerialPortInfo[]) | undefined;
  updaterSocket?: string | undefined;
  onSend?: ((type: MessageType, payload: unknown, correlationId?: string | undefined) => void) | undefined;
  onLog?: ((chunk: DeviceLogChunk) => void) | undefined;
  onLogError?: ((port: SerialDevice, error: Error) => void) | undefined;
}

export class ClientAgent {
  private readonly options: ClientAgentOptions;
  private readonly adapter: SerialAdapter;
  private readonly commandExecutor = new DeviceCommandExecutor();
  private readonly deviceManager: DeviceManager;
  private readonly bootIdValue = `boot-${randomUUID()}`;
  private readonly clientVersionValue: string;
  private readonly heartbeatIntervalMs: number;
  private readonly refreshIntervalMs: number;
  private snapshotRevision = 0;
  private socket: WebSocket | undefined;
  private reconnectDelay = 1000;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private clientIdValue = '';

  constructor(options: ClientAgentOptions) {
    this.options = options;
    this.clientVersionValue = options.clientVersion ?? '0.1.0';
    this.heartbeatIntervalMs = options.heartbeatMs ?? 10_000;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 5_000;
    this.adapter = options.adapter ?? new TvStickTestBoxAdapter(options.serialTimeoutMs ?? 3000);
    this.deviceManager = new DeviceManager({
      stateDirectory: options.stateDirectory,
      controlSelector: options.controlSelector,
      logSelector: options.logSelector,
      probeEnabled: options.probeEnabled,
      discoverPorts: options.discoverPorts,
      onLog: (chunk) => this.send('device.log.chunk', chunk),
      onLogError: (port, error) => {
        if (options.onLogError) options.onLogError(port, error);
        else console.error(JSON.stringify({ event: 'serial_log_error', portId: port.deviceId, message: error.message }));
      },
    });
  }

  get clientId(): string {
    return this.clientIdValue;
  }

  get bootId(): string {
    return this.bootIdValue;
  }

  start(): void {
    this.stopped = false;
    mkdirSync(this.options.stateDirectory, { recursive: true, mode: 0o750 });
    const clientIdPath = `${this.options.stateDirectory}/client-id`;
    this.clientIdValue = this.options.clientId?.trim()
      ?? (existsSync(clientIdPath) ? readFileSync(clientIdPath, 'utf8').trim() : `client-${randomUUID()}`);
    if (!existsSync(clientIdPath)) writeFileSync(clientIdPath, `${this.clientIdValue}\n`, { mode: 0o640 });
    this.refreshTimer = setInterval(() => { void this.refreshDevices(true); }, this.refreshIntervalMs).unref();
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close').catch(() => undefined);
      socket.close();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    await this.deviceManager.close();
  }

  async refreshDevices(sendSnapshot: boolean): Promise<void> {
    const changed = await this.deviceManager.refresh();
    if (changed && sendSnapshot) this.send('client.snapshot', this.snapshot());
  }

  receiveCommandExecute(raw: CommandRequest, correlationId: string): void {
    void this.executeCommand(raw, correlationId);
  }

  private send(type: MessageType, payload: unknown, correlationId?: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message(type, payload, this.clientIdValue, correlationId)));
    }
    this.options.onSend?.(type, payload, correlationId);
  }

  private snapshot(): ClientSnapshot {
    this.snapshotRevision += 1;
    const updateStatus = this.readUpdateStatus();
    return {
      snapshotRevision: this.snapshotRevision,
      clientVersion: this.clientVersionValue,
      bootId: this.bootIdValue,
      health: 'healthy',
      devices: this.deviceManager.serialPorts,
      managedDevices: this.deviceManager.managedDevices,
      ...(this.commandExecutor.activeCommandIds[0] ? { activeCommandId: this.commandExecutor.activeCommandIds[0] } : {}),
      ...(updateStatus ? { updateStatus } : {}),
    };
  }

  private readUpdateStatus(): ClientSnapshot['updateStatus'] {
    const statusPath = `${this.options.stateDirectory}/update-status.json`;
    if (!existsSync(statusPath)) return { state: 'idle', version: this.clientVersionValue };
    try {
      const value = JSON.parse(readFileSync(statusPath, 'utf8')) as ClientSnapshot['updateStatus'];
      return value?.state ? value : { state: 'idle', version: this.clientVersionValue };
    } catch {
      return { state: 'failed', version: this.clientVersionValue, message: 'unable to read update status' };
    }
  }

  private connect(): void {
    const socket = new WebSocket(this.options.serverUrl, this.options.token ? { headers: { Authorization: `Bearer ${this.options.token}` } } : undefined);
    this.socket = socket;
    socket.on('open', () => {
      if (this.stopped) return;
      this.reconnectDelay = 1000;
      this.send('client.hello', {
        clientVersion: this.clientVersionValue,
        protocolVersion: '1.0',
        bootId: this.bootIdValue,
        platform: platform(),
        architecture: arch(),
        capabilities: ['serial'],
        hostname: osHostname(),
        addresses: collectAddresses(),
      });
      this.heartbeatTimer = setInterval(() => this.send('client.heartbeat', { bootId: this.bootIdValue, clientVersion: this.clientVersionValue, snapshotRevision: this.snapshotRevision, health: 'healthy' }), this.heartbeatIntervalMs);
    });
    socket.on('message', (data) => {
      try {
        const envelope = parseEnvelope(data.toString());
        if (envelope.type === 'sync.request') void this.refreshDevices(false).then(() => this.send('client.snapshot', this.snapshot(), envelope.id));
        if (envelope.type === 'client.update') this.startUpdate(envelope.payload as UpdateRequest, envelope.id);
        if (envelope.type === 'command.execute') this.receiveCommandExecute(parseCommandRequest(envelope.payload), envelope.id);
      } catch (error) {
        console.error(JSON.stringify({ event: 'protocol_error', message: error instanceof Error ? error.message : 'invalid message' }));
      }
    });
    socket.on('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      if (this.socket === socket) this.socket = undefined;
      if (!this.stopped && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, this.reconnectDelay + Math.floor(Math.random() * 500));
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    });
    socket.on('error', (error) => console.error(JSON.stringify({ event: 'client_socket_error', message: error.message })));
  }

  private async executeCommand(raw: CommandRequest, correlationId: string): Promise<void> {
    const expiresAt = Date.parse(raw.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      this.send('command.failed', { commandId: raw.commandId, deviceId: raw.deviceId, success: false, error: { code: 'COMMAND_EXPIRED', message: 'command has expired', retryable: false } }, correlationId);
      return;
    }
    const target = this.deviceManager.resolveCommandTarget(raw.deviceId);
    if (!target) {
      this.send('command.failed', { commandId: raw.commandId, deviceId: raw.deviceId, success: false, error: { code: 'DEVICE_OFFLINE', message: 'device is not identified or has no control port', retryable: true } }, correlationId);
      return;
    }
    if (this.commandExecutor.isBusy(raw.deviceId)) {
      this.send('command.failed', { commandId: raw.commandId, deviceId: raw.deviceId, success: false, error: { code: 'SERIAL_BUSY', message: 'another serial command is running for this device', retryable: true } }, correlationId);
      return;
    }
    this.send('command.accepted', { commandId: raw.commandId, deviceId: raw.deviceId }, correlationId);
    const result = await this.commandExecutor.execute(raw, { ...target.port, deviceId: raw.deviceId }, this.adapter);
    this.send(result.success ? 'command.result' : 'command.failed', result, correlationId);
    this.send('client.snapshot', this.snapshot());
  }

  private startUpdate(request: UpdateRequest, correlationId: string): void {
    this.send('update.progress', { updateId: request.updateId, version: request.version, state: 'downloading', progress: 0 }, correlationId);
    const updaterRequest = { ...request, ...(this.options.token ? { downloadToken: this.options.token } : {}) };
    const updater = createConnection(this.options.updaterSocket ?? '/run/ttlab-updater/update.sock');
    updater.once('connect', () => updater.end(`${JSON.stringify(updaterRequest)}\n`));
    updater.once('error', (error) => {
      this.send('update.failed', { updateId: request.updateId, version: request.version, code: 'UPDATER_UNAVAILABLE', message: error.message }, correlationId);
    });
  }
}
