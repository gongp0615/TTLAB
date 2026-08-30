export type LogType = 'device' | 'event' | 'command' | 'audit' | 'agent' | 'error';

export const logTypes: readonly LogType[] = ['device', 'event', 'command', 'audit', 'agent', 'error'];

export function isLogType(value: unknown): value is LogType {
  return typeof value === 'string' && (logTypes as readonly string[]).includes(value);
}

export interface LogEntry {
  ts: string;
  type: LogType;
  clientId?: string;
  deviceId?: string;
  commandId?: string;
  actor?: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

export interface LogQueryOptions {
  types?: LogType[];
  clientId?: string;
  deviceId?: string;
  commandId?: string;
  actor?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface LogQueryResult {
  data: LogEntry[];
  hasMore: boolean;
  nextOffset: number;
  truncated: boolean;
}

export interface LogStoreStatus {
  healthy: boolean;
  writeFailures: number;
  activeWriters: number;
  logDirectory: string;
}

export interface LogWriteErrorContext {
  type: LogType;
  clientId?: string;
  sessionId?: string;
}

export interface LogStoreOptions {
  directory: string;
  flushIntervalMs?: number;
  flushThresholdBytes?: number;
  retentionDays?: number;
  retentionCheckIntervalMs?: number;
  maxScanBytes?: number;
  onError?: (error: Error, context: LogWriteErrorContext) => void;
}
