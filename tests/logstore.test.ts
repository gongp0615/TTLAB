import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LogStore } from '../apps/server/src/logstore/index.js';
import type { LogEntry } from '../apps/server/src/logstore/index.js';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function tsAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function createStore(options: Partial<ConstructorParameters<typeof LogStore>[0]> = {}): { store: LogStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-logstore-'));
  const store = new LogStore({
    directory: join(root, 'logs'),
    flushIntervalMs: 0,
    retentionCheckIntervalMs: 0,
    ...options,
  });
  store.start();
  return { store, root };
}

function deviceEntry(ts: string, clientId: string, deviceId: string, sequence: number, data: string): LogEntry {
  return { ts, type: 'device', clientId, deviceId, data: { sequence, data, encoding: 'utf-8', truncated: false } };
}

test('writes entries to type-specific JSON Lines files and flushes on demand', () => {
  const { store, root } = createStore();
  try {
    store.write(deviceEntry(tsAt(-5000), 'client-001', 'tvbox:one', 1, 'boot complete\n'));
    store.write(deviceEntry(tsAt(-4000), 'client-002', 'tvbox:two', 1, 'ready\n'));
    store.write({ ts: tsAt(-3000), type: 'event', clientId: 'client-001', data: { action: 'client.connected' } });
    store.write({ ts: tsAt(-2000), type: 'command', clientId: 'client-001', commandId: 'cmd-1', data: { status: 'dispatched', operation: 'system.ping' } });
    store.write({ ts: tsAt(-1000), type: 'audit', clientId: 'client-001', actor: 'anonymous', data: { action: 'command.dispatch' } });
    store.write({ ts: tsAt(0), type: 'agent', sessionId: 'session-1', data: { role: 'user', content: 'hello' } });
    store.flush();

    const date = todayKey();
    const deviceFile = join(root, 'logs', 'device', date, 'client-001.jsonl');
    const deviceLines = readFileSync(deviceFile, 'utf8').trim().split('\n');
    assert.equal(deviceLines.length, 1);
    const parsed = JSON.parse(deviceLines[0] ?? '') as LogEntry;
    assert.equal(parsed.type, 'device');
    assert.equal(parsed.deviceId, 'tvbox:one');
    assert.deepEqual(parsed.data, { sequence: 1, data: 'boot complete\n', encoding: 'utf-8', truncated: false });

    assert.equal(existsSync(join(root, 'logs', 'event', `${date}.jsonl`)), true);
    assert.equal(existsSync(join(root, 'logs', 'command', `${date}.jsonl`)), true);
    assert.equal(existsSync(join(root, 'logs', 'audit', `${date}.jsonl`)), true);
    assert.equal(existsSync(join(root, 'logs', 'agent', date, 'session-1.jsonl')), true);
    assert.equal(existsSync(join(root, 'logs', 'device', date, 'client-002.jsonl')), true);
  } finally {
    void store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('flushes automatically when the buffer threshold is reached', () => {
  const { store, root } = createStore({ flushThresholdBytes: 1024 });
  try {
    const bigData = 'x'.repeat(512);
    for (let index = 0; index < 5; index += 1) {
      store.write(deviceEntry(tsAt(-index * 1000), 'client-001', 'tvbox:one', index, bigData));
    }
    // the buffer exceeded the threshold, so the file exists before an explicit flush
    assert.equal(existsSync(join(root, 'logs', 'device', todayKey(), 'client-001.jsonl')), true);
  } finally {
    void store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('query filters by type, ids, keyword, and time range and returns chronological results', async () => {
  const { store, root } = createStore();
  try {
    store.write(deviceEntry(tsAt(-6000), 'client-001', 'tvbox:one', 1, 'boot complete\n'));
    store.write(deviceEntry(tsAt(-5000), 'client-002', 'tvbox:two', 1, 'usb error\n'));
    store.write(deviceEntry(tsAt(-4000), 'client-001', 'tvbox:one', 2, 'hdmi switched\n'));
    store.write({ ts: tsAt(-3000), type: 'event', clientId: 'client-001', data: { action: 'client.online' } });
    store.write({ ts: tsAt(-2000), type: 'audit', clientId: 'client-001', actor: 'anonymous', data: { action: 'command.dispatch' } });

    const allDevice = await store.query({ types: ['device'] });
    assert.equal(allDevice.data.length, 3);
    assert.equal(allDevice.data[0]?.data.sequence, 1);
    assert.equal(allDevice.data[2]?.data.sequence, 2);

    const byClient = await store.query({ types: ['device'], clientId: 'client-002' });
    assert.equal(byClient.data.length, 1);
    assert.equal(byClient.data[0]?.deviceId, 'tvbox:two');

    const byDevice = await store.query({ types: ['device'], deviceId: 'tvbox:two' });
    assert.equal(byDevice.data.length, 1);

    const byKeyword = await store.query({ types: ['device'], keyword: 'USb ErRor' });
    assert.equal(byKeyword.data.length, 1);
    assert.equal(byKeyword.data[0]?.clientId, 'client-002');

    const byRange = await store.query({ types: ['device'], from: tsAt(-5500), to: tsAt(-4500) });
    assert.equal(byRange.data.length, 1);
    assert.equal(byRange.data[0]?.data.sequence, 1);

    const events = await store.query({ types: ['event'] });
    assert.equal(events.data.length, 1);
    assert.equal(events.data[0]?.data.action, 'client.online');

    const audits = await store.query({ types: ['audit'], actor: 'anonymous' });
    assert.equal(audits.data.length, 1);
    assert.equal(audits.data[0]?.data.action, 'command.dispatch');
  } finally {
    void store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('query paginates with limit, offset, and hasMore', async () => {
  const { store, root } = createStore();
  try {
    for (let index = 1; index <= 5; index += 1) {
      store.write(deviceEntry(tsAt(-index * 1000), 'client-001', 'tvbox:one', index, `line ${index}\n`));
    }
    const first = await store.query({ types: ['device'], limit: 2, offset: 0 });
    assert.equal(first.data.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 2);
    assert.equal(first.data[0]?.data.sequence, 5);

    const second = await store.query({ types: ['device'], limit: 2, offset: first.nextOffset });
    assert.equal(second.data.length, 2);
    assert.equal(second.hasMore, true);
    assert.equal(second.nextOffset, 4);
    assert.equal(second.data[0]?.data.sequence, 3);

    const last = await store.query({ types: ['device'], limit: 2, offset: second.nextOffset });
    assert.equal(last.data.length, 1);
    assert.equal(last.hasMore, false);
    assert.equal(last.data[0]?.data.sequence, 1);
  } finally {
    void store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('query marks results truncated when the scan byte budget is exhausted', async () => {
  const { store, root } = createStore({ maxScanBytes: 128 });
  try {
    const bigData = 'y'.repeat(256);
    for (let index = 1; index <= 4; index += 1) {
      store.write(deviceEntry(tsAt(-index * 1000), 'client-001', 'tvbox:one', index, bigData));
    }
    const result = await store.query({ types: ['device'] });
    assert.equal(result.truncated, true);
    assert.ok(result.data.length < 4, 'byte budget should limit how much is scanned');
  } finally {
    void store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('retention removes expired date files on startup and keeps recent ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-logstore-'));
  const directory = join(root, 'logs');
  const first = new LogStore({ directory, flushIntervalMs: 0, retentionCheckIntervalMs: 0 });
  first.start();
  first.write(deviceEntry(tsAt(-2 * 24 * 60 * 60 * 1000), 'client-001', 'tvbox:one', 1, 'old\n'));
  first.write(deviceEntry(tsAt(0), 'client-001', 'tvbox:one', 2, 'new\n'));
  first.flush();
  await first.close();

  const second = new LogStore({ directory, flushIntervalMs: 0, retentionCheckIntervalMs: 0, retentionDays: 1 });
  second.start();
  const dates = readdirSync(join(directory, 'device'));
  assert.deepEqual(dates, [todayKey()]);
  await second.close();
  rmSync(root, { recursive: true, force: true });
});

test('write failures do not throw and are surfaced through onError', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-logstore-'));
  const errors: string[] = [];
  const store = new LogStore({
    directory: join(root, 'logs'),
    flushIntervalMs: 0,
    retentionCheckIntervalMs: 0,
    onError: (error, context) => { errors.push(`${context.type}:${error.message}`); },
  });
  store.start();
  try {
    store.write({ ts: 'not-a-date', type: 'event', clientId: 'client-001', data: {} });
    store.write({ ts: tsAt(0), type: 'unknown' as LogEntry['type'], data: {} });
    assert.ok(errors.length >= 2);
    // the store remains usable after errors
    store.write(deviceEntry(tsAt(-1000), 'client-001', 'tvbox:one', 1, 'ok\n'));
    store.flush();
    assert.equal(existsSync(join(root, 'logs', 'device', todayKey(), 'client-001.jsonl')), true);
  } finally {
    void store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('buffered entries are visible to queries before an explicit flush', async () => {
  const { store, root } = createStore();
  try {
    store.write(deviceEntry(tsAt(-1000), 'client-001', 'tvbox:one', 1, 'hello\n'));
    const result = await store.query({ types: ['device'] });
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.data.data, 'hello\n');
  } finally {
    void store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
