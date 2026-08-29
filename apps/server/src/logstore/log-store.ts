import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  isLogType,
  logTypes,
  type LogEntry,
  type LogQueryOptions,
  type LogQueryResult,
  type LogStoreOptions,
  type LogStoreStatus,
  type LogType,
  type LogWriteErrorContext,
} from './types.js';

const DATE_FILE_NAME = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_OFFSET = 100_000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface WriterState {
  fd: number;
  buffer: string[];
  bufferBytes: number;
  failed: boolean;
  context: LogWriteErrorContext;
}

interface ScanFilter {
  fromMs: number;
  toMs: number;
  clientId?: string;
  deviceId?: string;
  commandId?: string;
  actor?: string;
  sessionId?: string;
  keyword?: string;
}

interface ScanResult {
  entries: LogEntry[];
  bytes: number;
  budgetExceeded: boolean;
}

function safeFileName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized.length === 0 ? 'unknown' : sanitized.slice(0, 120);
}

function utcDateKey(ts: string): string {
  const date = new Date(ts);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ts.slice(0, 10);
}

function expiredDateFile(name: string, cutoffDate: string): boolean {
  const date = name.replace(/\.jsonl$/, '');
  return DATE_FILE_NAME.test(date) && date < cutoffDate;
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return dates;
  const current = new Date(start);
  while (current.getTime() <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class LogStore {
  private readonly directory: string;
  private readonly flushIntervalMs: number;
  private readonly flushThresholdBytes: number;
  private readonly retentionDays: number;
  private readonly retentionCheckIntervalMs: number;
  private readonly maxScanBytes: number;
  private readonly onError: ((error: Error, context: LogWriteErrorContext) => void) | undefined;
  private readonly writers = new Map<string, WriterState>();
  private readonly flushTimer: NodeJS.Timeout | undefined;
  private readonly retentionTimer: NodeJS.Timeout | undefined;
  private writeFailures = 0;
  private healthy = true;

  constructor(options: LogStoreOptions) {
    this.directory = options.directory;
    this.flushIntervalMs = options.flushIntervalMs ?? 500;
    this.flushThresholdBytes = options.flushThresholdBytes ?? 256 * 1024;
    this.retentionDays = options.retentionDays ?? 30;
    this.retentionCheckIntervalMs = options.retentionCheckIntervalMs ?? 24 * 60 * 60 * 1000;
    this.maxScanBytes = options.maxScanBytes ?? 64 * 1024 * 1024;
    this.onError = options.onError;
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs).unref();
    }
    if (this.retentionCheckIntervalMs > 0) {
      this.retentionTimer = setInterval(() => this.enforceRetention(), this.retentionCheckIntervalMs).unref();
    }
  }

  start(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o750 });
    this.enforceRetention();
  }

  write(entry: LogEntry): void {
    if (!isLogType(entry.type)) {
      this.reportError(new Error(`unsupported log type: ${String(entry.type)}`), { type: entry.type as LogType, ...(entry.clientId !== undefined ? { clientId: entry.clientId } : {}) });
      return;
    }
    if (!Number.isFinite(Date.parse(entry.ts))) {
      this.reportError(new Error('invalid log timestamp'), { type: entry.type, ...(entry.clientId !== undefined ? { clientId: entry.clientId } : {}) });
      return;
    }
    try {
      const line = `${JSON.stringify(entry)}\n`;
      const key = this.resolveKey(entry);
      const writer = this.writerFor(key, entry);
      if (!writer || writer.failed) return;
      writer.buffer.push(line);
      writer.bufferBytes += Buffer.byteLength(line, 'utf8');
      if (writer.bufferBytes >= this.flushThresholdBytes) this.flushWriter(writer);
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error('log write failed'), { type: entry.type, ...(entry.clientId !== undefined ? { clientId: entry.clientId } : {}) });
    }
  }

  flush(): void {
    for (const writer of this.writers.values()) {
      if (!writer.failed) this.flushWriter(writer);
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer);
    if (this.retentionTimer !== undefined) clearInterval(this.retentionTimer);
    this.flush();
    for (const writer of this.writers.values()) {
      try { fsyncSync(writer.fd); } catch { /* fd already closed */ }
      try { closeSync(writer.fd); } catch { /* fd already closed */ }
    }
    this.writers.clear();
  }

  status(): LogStoreStatus {
    return {
      healthy: this.healthy,
      writeFailures: this.writeFailures,
      activeWriters: this.writers.size,
      logDirectory: this.directory,
    };
  }

  async query(options: LogQueryOptions): Promise<LogQueryResult> {
    this.flush();
    const types = options.types !== undefined && options.types.length > 0 ? options.types : (['device'] as LogType[]);
    const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clamp(options.offset ?? 0, 0, MAX_OFFSET);
    const now = Date.now();
    const fromMs = options.from !== undefined ? Date.parse(options.from) : now - DEFAULT_WINDOW_MS;
    const toMs = options.to !== undefined ? Date.parse(options.to) : now;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return { data: [], hasMore: false, nextOffset: offset, truncated: false };

    const filter: ScanFilter = {
      fromMs,
      toMs,
      ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.keyword !== undefined && options.keyword.trim().length > 0 ? { keyword: options.keyword.trim().toLowerCase() } : {}),
    };

    const fromDate = utcDateKey(new Date(fromMs).toISOString());
    const toDate = utcDateKey(new Date(toMs).toISOString());
    const matched: LogEntry[] = [];
    const target = offset + limit + 1;
    let scannedBytes = 0;
    let truncated = false;

    outer:
    for (const type of types) {
      for (const date of dateRange(fromDate, toDate)) {
        for (const filePath of this.filesFor(type, date, filter)) {
          const budget = this.maxScanBytes - scannedBytes;
          const result = await this.scanFile(filePath, filter, Math.max(budget, 0));
          scannedBytes += result.bytes;
          matched.push(...result.entries);
          if (result.budgetExceeded || scannedBytes >= this.maxScanBytes) {
            truncated = true;
            break outer;
          }
          if (matched.length >= target) break outer;
        }
      }
    }

    matched.sort((a, b) => a.ts.localeCompare(b.ts));
    const hasMore = matched.length > offset + limit;
    return {
      data: matched.slice(offset, offset + limit),
      hasMore,
      nextOffset: offset + matched.slice(offset, offset + limit).length,
      truncated,
    };
  }

  private resolveKey(entry: LogEntry): string {
    const date = utcDateKey(entry.ts);
    if (entry.type === 'device') return `device/${date}/${safeFileName(entry.clientId ?? 'unknown')}.jsonl`;
    if (entry.type === 'agent') return `agent/${date}/${safeFileName(entry.sessionId ?? 'unknown')}.jsonl`;
    return `${entry.type}/${date}.jsonl`;
  }

  private writerFor(key: string, entry: LogEntry): WriterState | undefined {
    const existing = this.writers.get(key);
    if (existing !== undefined) return existing;
    const filePath = join(this.directory, key);
    let fd: number;
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o750 });
      fd = openSync(filePath, 'a', 0o640);
    } catch (error) {
      this.recordWriteFailure(error, entry.type, entry.clientId, entry.sessionId);
      return undefined;
    }
    const state: WriterState = {
      fd,
      buffer: [],
      bufferBytes: 0,
      failed: false,
      context: { type: entry.type, ...(entry.clientId !== undefined ? { clientId: entry.clientId } : {}), ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}) },
    };
    this.writers.set(key, state);
    return state;
  }

  private flushWriter(writer: WriterState): void {
    if (writer.buffer.length === 0 || writer.failed) return;
    const chunk = writer.buffer.join('');
    writer.buffer = [];
    writer.bufferBytes = 0;
    try {
      writeSync(writer.fd, chunk);
    } catch (error) {
      writer.failed = true;
      this.recordWriteFailure(error, writer.context.type, writer.context.clientId, writer.context.sessionId);
    }
  }

  private recordWriteFailure(error: unknown, type: LogType, clientId?: string, sessionId?: string): void {
    this.writeFailures += 1;
    this.healthy = false;
    const message = error instanceof Error ? error.message : 'log write failed';
    this.reportError(new Error(message), { type, ...(clientId !== undefined ? { clientId } : {}), ...(sessionId !== undefined ? { sessionId } : {}) });
  }

  private reportError(error: Error, context: LogWriteErrorContext): void {
    if (this.onError !== undefined) {
      this.onError(error, context);
    } else {
      const detail = { ...context };
      console.error(JSON.stringify({ event: 'logstore_error', message: error.message, ...detail }));
    }
  }

  private filesFor(type: LogType, date: string, filter: ScanFilter): string[] {
    if (type === 'device') {
      const dir = join(this.directory, 'device', date);
      if (filter.clientId !== undefined) return [join(dir, `${safeFileName(filter.clientId)}.jsonl`)];
      return this.listJsonl(dir);
    }
    if (type === 'agent') {
      const dir = join(this.directory, 'agent', date);
      if (filter.sessionId !== undefined) return [join(dir, `${safeFileName(filter.sessionId)}.jsonl`)];
      return this.listJsonl(dir);
    }
    return [join(this.directory, type, `${date}.jsonl`)];
  }

  private listJsonl(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort().map((name) => join(directory, name));
  }

  private async scanFile(filePath: string, filter: ScanFilter, budget: number): Promise<ScanResult> {
    if (!existsSync(filePath) || budget <= 0) return { entries: [], bytes: 0, budgetExceeded: false };
    const entries: LogEntry[] = [];
    let bytes = 0;
    let budgetExceeded = false;
    const readline = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    try {
      for await (const line of readline) {
        bytes += Buffer.byteLength(line, 'utf8') + 1;
        if (bytes > budget) {
          budgetExceeded = true;
          break;
        }
        let entry: LogEntry;
        try {
          entry = JSON.parse(line) as LogEntry;
        } catch {
          continue;
        }
        if (this.matches(entry, filter)) entries.push(entry);
      }
    } finally {
      readline.close();
    }
    return { entries, bytes, budgetExceeded };
  }

  private matches(entry: LogEntry, filter: ScanFilter): boolean {
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < filter.fromMs || ts > filter.toMs) return false;
    if (filter.clientId !== undefined && entry.clientId !== filter.clientId) return false;
    if (filter.deviceId !== undefined && entry.deviceId !== filter.deviceId) return false;
    if (filter.commandId !== undefined && entry.commandId !== filter.commandId) return false;
    if (filter.actor !== undefined && entry.actor !== filter.actor) return false;
    if (filter.sessionId !== undefined && entry.sessionId !== filter.sessionId) return false;
    if (filter.keyword !== undefined) {
      try {
        if (!JSON.stringify(entry).toLowerCase().includes(filter.keyword)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private enforceRetention(): void {
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      for (const type of logTypes) {
        const typeDirectory = join(this.directory, type);
        if (!existsSync(typeDirectory)) continue;
        for (const name of readdirSync(typeDirectory)) {
          const entryPath = join(typeDirectory, name);
          if (!expiredDateFile(name, cutoff)) continue;
          try {
            const stat = statSync(entryPath);
            rmSync(entryPath, { recursive: stat.isDirectory(), force: true });
          } catch (error) {
            this.reportError(error instanceof Error ? error : new Error('log retention failed'), { type });
          }
        }
      }
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error('log retention failed'), { type: 'event' });
    }
  }
}
