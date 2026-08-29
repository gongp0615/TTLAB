import { randomUUID } from 'node:crypto';

export type MessageType =
  | 'client.hello'
  | 'client.snapshot'
  | 'client.heartbeat'
  | 'sync.request'
  | 'command.execute'
  | 'command.accepted'
  | 'command.progress'
  | 'command.result'
  | 'command.failed'
  | 'client.update'
  | 'update.progress'
  | 'update.completed'
  | 'update.failed'
  | 'device.log.chunk';

export const protocolVersion = '1.0' as const;

export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface Envelope<TPayload = unknown> {
  id: string;
  version: '1.0';
  type: MessageType;
  timestamp: string;
  clientId?: string;
  correlationId?: string;
  payload: TPayload;
}

export interface ClientHello {
  clientVersion: string;
  protocolVersion: string;
  bootId: string;
  platform: string;
  architecture: string;
  capabilities: string[];
}

export interface SerialDevice {
  deviceId: string;
  path: string;
  stableIdentity: boolean;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  status: 'available' | 'busy' | 'error' | 'removed';
  deviceType?: string;
  observedAt: string;
  portRole?: 'control' | 'log' | 'dut-debug' | 'unknown' | 'log-candidate';
  parentDeviceId?: string;
  hardwareKey?: string;
}

export interface ManagedDevice {
  deviceId: string;
  deviceType: string;
  displayName: string;
  stableIdentity: string;
  status: 'identified' | 'matched' | 'partial' | 'ambiguous' | 'offline' | 'error';
  ports: SerialDevice[];
  capabilities: string[];
  observedAt: string;
  identification?: {
    method: 'hardware' | 'probe' | 'binding';
    confidence: 'high' | 'medium' | 'low';
    message?: string;
  };
}

export interface DeviceLogChunk {
  deviceId: string;
  portId: string;
  sequence: number;
  capturedAt: string;
  data: string;
  encoding: 'utf-8' | 'base64';
  truncated: boolean;
}

export interface ClientSnapshot {
  snapshotRevision: number;
  clientVersion: string;
  bootId: string;
  health: 'healthy' | 'degraded';
  devices: SerialDevice[];
  managedDevices?: ManagedDevice[];
  activeCommandId?: string;
  updateStatus?: {
    state: 'idle' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'healthy' | 'failed' | 'rolled_back';
    version?: string;
    message?: string;
  };
}

export interface CommandRequest {
  commandId: string;
  deviceId: string;
  operation: string;
  parameters: Record<string, string>;
  issuedAt: string;
  expiresAt: string;
}

export interface CommandResult {
  commandId: string;
  deviceId: string;
  success: boolean;
  output?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface UpdateManifest {
  version: string;
  platform: string;
  architecture: string;
  artifact: string;
  sha256: string;
  signature: string;
  minProtocolVersion: string;
}

export interface UpdateRequest extends UpdateManifest {
  updateId: string;
  downloadUrl: string;
  expiresAt: string;
}

export function message<TPayload>(type: MessageType, payload: TPayload, clientId?: string, correlationId?: string): Envelope<TPayload> {
  return {
    id: `msg_${randomUUID()}`,
    version: protocolVersion,
    type,
    timestamp: new Date().toISOString(),
    ...(clientId === undefined ? {} : { clientId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    payload,
  };
}

export function parseEnvelope(raw: string): Envelope {
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new ProtocolError('MESSAGE_TOO_LARGE', 'message exceeds 1 MiB');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError('PROTOCOL_ERROR', 'message is not valid JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('message must be an object');
  const candidate = value as Record<string, unknown>;
  const knownTypes: MessageType[] = ['client.hello', 'client.snapshot', 'client.heartbeat', 'sync.request', 'command.execute', 'command.accepted', 'command.progress', 'command.result', 'command.failed', 'client.update', 'update.progress', 'update.completed', 'update.failed', 'device.log.chunk'];
  if (typeof candidate.id !== 'string' || candidate.version !== protocolVersion || typeof candidate.type !== 'string' || !knownTypes.includes(candidate.type as MessageType) || !Number.isFinite(Date.parse(String(candidate.timestamp))) || !('payload' in candidate)) {
    throw new ProtocolError('PROTOCOL_ERROR', 'invalid message envelope');
  }
  return candidate as unknown as Envelope;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('INVALID_ARGUMENT', `${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== 'string' || value[field].length === 0) throw new ProtocolError('INVALID_ARGUMENT', `${field} is required`);
  return value[field];
}

export function parseClientHello(payload: unknown): ClientHello {
  const value = object(payload, 'hello');
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === 'string')) throw new ProtocolError('INVALID_ARGUMENT', 'capabilities must be a string array');
  return { clientVersion: stringField(value, 'clientVersion'), protocolVersion: stringField(value, 'protocolVersion'), bootId: stringField(value, 'bootId'), platform: stringField(value, 'platform'), architecture: stringField(value, 'architecture'), capabilities };
}

export function parseClientSnapshot(payload: unknown): ClientSnapshot {
  const value = object(payload, 'snapshot');
  if (!Number.isSafeInteger(value.snapshotRevision) || Number(value.snapshotRevision) < 1 || (value.health !== 'healthy' && value.health !== 'degraded') || !Array.isArray(value.devices)) throw new ProtocolError('INVALID_ARGUMENT', 'invalid client snapshot');
  return value as unknown as ClientSnapshot;
}

export function parseCommandRequest(payload: unknown): CommandRequest {
  const value = object(payload, 'command');
  const parameters = object(value.parameters, 'parameters');
  if (!Object.values(parameters).every((item) => typeof item === 'string' && item.length <= 128)) throw new ProtocolError('INVALID_ARGUMENT', 'command parameters must be short strings');
  return { commandId: stringField(value, 'commandId'), deviceId: stringField(value, 'deviceId'), operation: stringField(value, 'operation'), parameters: parameters as Record<string, string>, issuedAt: stringField(value, 'issuedAt'), expiresAt: stringField(value, 'expiresAt') };
}

export function parseCommandResult(payload: unknown): CommandResult {
  const value = object(payload, 'command result');
  if (typeof value.success !== 'boolean') throw new ProtocolError('INVALID_ARGUMENT', 'command result success is required');
  return value as unknown as CommandResult;
}

export function parseDeviceLogChunk(payload: unknown): DeviceLogChunk {
  const value = object(payload, 'device log chunk');
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || typeof value.data !== 'string' || (value.encoding !== 'utf-8' && value.encoding !== 'base64') || typeof value.truncated !== 'boolean') throw new ProtocolError('INVALID_ARGUMENT', 'invalid device log chunk');
  return value as unknown as DeviceLogChunk;
}
