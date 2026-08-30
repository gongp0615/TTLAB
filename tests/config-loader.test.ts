import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_CLIENT_CONFIG,
  DEFAULT_UPDATER_CONFIG,
  loadJsonConfig,
  validateClientConfig,
  validateUpdaterConfig,
} from '../packages/config/src/index.js';

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ttlab-config-'));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('loadJsonConfig returns defaults when the default-path file is missing', () => {
  const missing = join(tempDir, 'client.json');
  const { config } = loadJsonConfig(missing, DEFAULT_CLIENT_CONFIG);
  assert.deepEqual(config, DEFAULT_CLIENT_CONFIG);
});

test('loadJsonConfig throws when an explicit --config file is missing', () => {
  const missing = join(tempDir, 'client.json');
  assert.throws(() => loadJsonConfig(missing, DEFAULT_CLIENT_CONFIG, { requireFile: true }), /config file not found/);
});

test('loadJsonConfig merges partial config over defaults', () => {
  const file = join(tempDir, 'client.json');
  writeFileSync(file, JSON.stringify({ serverUrl: 'ws://10.0.0.5:9000/agent/v1/session', heartbeatMs: 5000 }));
  const { config } = loadJsonConfig(file, DEFAULT_CLIENT_CONFIG, { validate: validateClientConfig });
  assert.equal(config.serverUrl, 'ws://10.0.0.5:9000/agent/v1/session');
  assert.equal(config.heartbeatMs, 5000);
  assert.equal(config.stateDirectory, DEFAULT_CLIENT_CONFIG.stateDirectory);
  assert.equal(config.dfu.vid, '28e9');
});

test('loadJsonConfig merges nested dfu object', () => {
  const file = join(tempDir, 'client.json');
  writeFileSync(file, JSON.stringify({ dfu: { vid: 'dead' } }));
  const { config } = loadJsonConfig(file, DEFAULT_CLIENT_CONFIG, { validate: validateClientConfig });
  assert.equal(config.dfu.vid, 'dead');
  assert.equal(config.dfu.utilPath, 'dfu-util');
});

test('loadJsonConfig throws on invalid JSON', () => {
  const file = join(tempDir, 'client.json');
  writeFileSync(file, '{ not json');
  assert.throws(() => loadJsonConfig(file, DEFAULT_CLIENT_CONFIG), /invalid JSON/);
});

test('loadJsonConfig throws when the file is not a JSON object', () => {
  const file = join(tempDir, 'client.json');
  writeFileSync(file, '[1,2,3]');
  assert.throws(() => loadJsonConfig(file, DEFAULT_CLIENT_CONFIG), /must contain a JSON object/);
});

test('validateClientConfig rejects an invalid serverUrl', () => {
  const file = join(tempDir, 'client.json');
  writeFileSync(file, JSON.stringify({ serverUrl: 'http://example.com' }));
  assert.throws(() => loadJsonConfig(file, DEFAULT_CLIENT_CONFIG, { validate: validateClientConfig }), /serverUrl must start with ws:\/\/ or wss:\/\//);
});

test('validateClientConfig requires a token when authEnabled is true', () => {
  const file = join(tempDir, 'client.json');
  writeFileSync(file, JSON.stringify({ authEnabled: true, token: '' }));
  assert.throws(() => loadJsonConfig(file, DEFAULT_CLIENT_CONFIG, { validate: validateClientConfig }), /token is required when authEnabled is true/);
});

test('validateClientConfig rejects a non-numeric heartbeatMs', () => {
  const file = join(tempDir, 'client.json');
  writeFileSync(file, JSON.stringify({ heartbeatMs: 'soon' }));
  assert.throws(() => loadJsonConfig(file, DEFAULT_CLIENT_CONFIG, { validate: validateClientConfig }), /heartbeatMs must be a positive number/);
});

test('validateUpdaterConfig accepts the default config and rejects bad values', () => {
  const valid = validateUpdaterConfig(DEFAULT_UPDATER_CONFIG);
  assert.deepEqual(valid, []);
  const file = join(tempDir, 'updater.json');
  writeFileSync(file, JSON.stringify({ installRoot: 42 }));
  assert.throws(() => loadJsonConfig(file, DEFAULT_UPDATER_CONFIG, { validate: validateUpdaterConfig }), /installRoot must be a non-empty string/);
});
