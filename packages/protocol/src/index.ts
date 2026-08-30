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
  hostname?: string;
  addresses?: string[];
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
  operations?: DeviceOperation[];
  observedAt: string;
  identification?: {
    method: 'hardware' | 'probe' | 'binding';
    confidence: 'high' | 'medium' | 'low';
    message?: string;
  };
}

export interface CommandParameterSchema {
  name: string;
  label?: string;
  type: 'enum' | 'string';
  options?: string[];
  pattern?: string;
  placeholder?: string;
  required?: boolean;
}

export interface DeviceOperation {
  operation: string;
  displayName?: string;
  description?: string;
  risk?: 'low' | 'high';
  command: string;
  responsePrefix?: string;
  parameters: CommandParameterSchema[];
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
  firmware?: FirmwareDownloadRef;
}

export interface FirmwareDownloadRef {
  release: string;
  artifact: string;
  downloadUrl: string;
  sha256: string;
  expiresAt: string;
}

export interface CommandProgress {
  commandId: string;
  deviceId: string;
  stage: 'downloading' | 'verifying' | 'entering-dfu' | 'waiting-for-dfu' | 'flashing' | 'verifying-flash' | 'restarting' | 'verifying-firmware';
  progress: number;
  message?: string;
}

export interface FirmwareManifest {
  version: string;
  artifact: string;
  sha256: string;
  size: number;
  /** 该固件兼容的设备分类（deviceTypes）；单个固件文件可对应多个分类 */
  deviceTypes: string[];
  releasedAt: string;
  description?: string;
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
  const hello: ClientHello = { clientVersion: stringField(value, 'clientVersion'), protocolVersion: stringField(value, 'protocolVersion'), bootId: stringField(value, 'bootId'), platform: stringField(value, 'platform'), architecture: stringField(value, 'architecture'), capabilities };
  if (typeof value.hostname === 'string' && value.hostname.length > 0) hello.hostname = value.hostname;
  if (Array.isArray(value.addresses) && value.addresses.every((item) => typeof item === 'string')) hello.addresses = value.addresses as string[];
  return hello;
}

export function parseClientSnapshot(payload: unknown): ClientSnapshot {
  const value = object(payload, 'snapshot');
  if (!Number.isSafeInteger(value.snapshotRevision) || Number(value.snapshotRevision) < 1 || (value.health !== 'healthy' && value.health !== 'degraded') || !Array.isArray(value.devices)) throw new ProtocolError('INVALID_ARGUMENT', 'invalid client snapshot');
  return value as unknown as ClientSnapshot;
}

const safeSegmentPattern = /^[A-Za-z0-9._-]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/i;

function parseFirmwareReference(value: Record<string, unknown>): FirmwareDownloadRef {
  const release = stringField(value, 'release');
  const artifact = stringField(value, 'artifact');
  const downloadUrl = stringField(value, 'downloadUrl');
  const sha256 = stringField(value, 'sha256');
  const expiresAt = stringField(value, 'expiresAt');
  if (!safeSegmentPattern.test(release) || !safeSegmentPattern.test(artifact)) throw new ProtocolError('INVALID_ARGUMENT', 'firmware release and artifact must be safe path segments');
  if (!sha256Pattern.test(sha256)) throw new ProtocolError('INVALID_ARGUMENT', 'firmware sha256 must be a 64 character hex digest');
  if (!/^https?:\/\/.+/.test(downloadUrl)) throw new ProtocolError('INVALID_ARGUMENT', 'firmware downloadUrl must be an http(s) URL');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new ProtocolError('INVALID_ARGUMENT', 'firmware downloadUrl has an invalid expiry');
  return { release, artifact, downloadUrl, sha256, expiresAt };
}

export function parseCommandRequest(payload: unknown): CommandRequest {
  const value = object(payload, 'command');
  const parameters = object(value.parameters, 'parameters');
  if (!Object.values(parameters).every((item) => typeof item === 'string' && item.length <= 128)) throw new ProtocolError('INVALID_ARGUMENT', 'command parameters must be short strings');
  const request: CommandRequest = { commandId: stringField(value, 'commandId'), deviceId: stringField(value, 'deviceId'), operation: stringField(value, 'operation'), parameters: parameters as Record<string, string>, issuedAt: stringField(value, 'issuedAt'), expiresAt: stringField(value, 'expiresAt') };
  if (value.firmware !== undefined) request.firmware = parseFirmwareReference(object(value.firmware, 'firmware'));
  return request;
}

export function parseCommandProgress(payload: unknown): CommandProgress {
  const value = object(payload, 'command progress');
  const stage = value.stage;
  const knownStages = ['downloading', 'verifying', 'entering-dfu', 'waiting-for-dfu', 'flashing', 'verifying-flash', 'restarting', 'verifying-firmware'];
  if (!knownStages.includes(stage as string)) throw new ProtocolError('INVALID_ARGUMENT', 'command progress stage is invalid');
  if (!Number.isFinite(value.progress) || Number(value.progress) < 0 || Number(value.progress) > 100) throw new ProtocolError('INVALID_ARGUMENT', 'command progress must be between 0 and 100');
  const progress: CommandProgress = { commandId: stringField(value, 'commandId'), deviceId: stringField(value, 'deviceId'), stage: stage as CommandProgress['stage'], progress: Number(value.progress) };
  if (typeof value.message === 'string' && value.message.length > 0) progress.message = value.message;
  return progress;
}

export function parseCommandResult(payload: unknown): CommandResult {
  const value = object(payload, 'command result');
  if (typeof value.success !== 'boolean') throw new ProtocolError('INVALID_ARGUMENT', 'command result success is required');
  return value as unknown as CommandResult;
}

// Validates command parameters against a device operation catalog entry.
// Returns a human-readable error message, or undefined when valid.
export function validateCommandParameters(operation: DeviceOperation | undefined, parameters: Record<string, unknown>): string | undefined {
  if (!operation) return 'operation is not supported';
  if (!operation.parameters || operation.parameters.length === 0) return undefined;
  const errors: string[] = [];
  for (const schema of operation.parameters) {
    const value = parameters[schema.name];
    if (value === undefined || value === '') {
      if (schema.required !== false) errors.push(`parameter ${schema.label ?? schema.name} is required`);
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`parameter ${schema.name} must be a string`);
      continue;
    }
    if (schema.type === 'enum' && schema.options && !schema.options.includes(value)) {
      errors.push(`parameter ${schema.name} must be one of ${schema.options.join(', ')}`);
    }
    if (schema.type === 'string' && schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`parameter ${schema.name} has an invalid format`);
      } catch {
        errors.push(`parameter ${schema.name} has an invalid pattern`);
      }
    }
  }
  return errors.length > 0 ? errors.join('; ') : undefined;
}

export function parseDeviceLogChunk(payload: unknown): DeviceLogChunk {
  const value = object(payload, 'device log chunk');
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || typeof value.data !== 'string' || (value.encoding !== 'utf-8' && value.encoding !== 'base64') || typeof value.truncated !== 'boolean') throw new ProtocolError('INVALID_ARGUMENT', 'invalid device log chunk');
  return value as unknown as DeviceLogChunk;
}
