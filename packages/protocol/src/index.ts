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
  | 'update.failed';

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
}

export interface ClientSnapshot {
  snapshotRevision: number;
  clientVersion: string;
  bootId: string;
  health: 'healthy' | 'degraded';
  devices: SerialDevice[];
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
    version: '1.0',
    type,
    timestamp: new Date().toISOString(),
    ...(clientId === undefined ? {} : { clientId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    payload,
  };
}

export function parseEnvelope(raw: string): Envelope {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('message must be an object');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.version !== '1.0' || typeof candidate.type !== 'string' || typeof candidate.timestamp !== 'string' || !('payload' in candidate)) {
    throw new Error('invalid message envelope');
  }
  return candidate as unknown as Envelope;
}
