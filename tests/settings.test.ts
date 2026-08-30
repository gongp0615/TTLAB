import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsError, SettingsStore, parseAgentSettingsPatch, toAgentSettingsView } from '../apps/server/src/settings/index.js';

function configWith(extra = ''): string {
  return [
    '# TTLAB Server runtime configuration.',
    'TTLAB_SERVER_PORT=9000',
    '# Agent section',
    'TTLAB_AGENT_ENABLED=1',
    'TTLAB_AGENT_MODEL=deepseek-chat',
    'TTLAB_DEEPSEEK_API_KEY=secret-key',
    'TTLAB_AGENT_LLM_URL=https://api.deepseek.com',
    'TTLAB_AGENT_MAX_SESSIONS=8',
    'TTLAB_AGENT_APPROVAL_TIMEOUT_MS=60000',
    'TTLAB_TLS_REQUIRED=0',
    extra,
    '',
  ].filter((line) => line !== undefined).join('\n');
}

test('settings store loads agent settings from the config file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-settings-'));
  const config = join(root, 'server.env');
  writeFileSync(config, configWith());
  try {
    const store = new SettingsStore(config);
    const settings = store.get();
    assert.equal(settings.enabled, true);
    assert.equal(settings.model, 'deepseek-chat');
    assert.equal(settings.apiKey, 'secret-key');
    assert.equal(settings.maxSessions, 8);
    assert.equal(settings.agentToken, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings store uses defaults for missing config keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-settings-'));
  const config = join(root, 'server.env');
  writeFileSync(config, 'TTLAB_SERVER_PORT=9000\n');
  try {
    const store = new SettingsStore(config);
    const settings = store.get();
    assert.equal(settings.enabled, false);
    assert.equal(settings.model, 'deepseek-chat');
    assert.equal(settings.apiKey, '');
    assert.equal(settings.llmUrl, 'https://api.deepseek.com');
    assert.equal(settings.engine, 'server-native');
    assert.equal(settings.dshBaseUrl, 'http://127.0.0.1:9333');
    assert.equal(settings.dshWorkdir, './data/agent-work');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings store loads and validates the dsh engine config', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-settings-'));
  const config = join(root, 'server.env');
  writeFileSync(config, [
    'TTLAB_AGENT_ENABLED=1',
    'TTLAB_AGENT_ENGINE=dsh',
    'TTLAB_DSH_BASE_URL=http://127.0.0.1:9333',
    'TTLAB_DSH_WORKDIR=./data/agent-work',
    'TTLAB_DSH_TOKEN=dsh-secret',
    '',
  ].join('\n'));
  try {
    const store = new SettingsStore(config);
    const settings = store.get();
    assert.equal(settings.engine, 'dsh');
    assert.equal(settings.dshBaseUrl, 'http://127.0.0.1:9333');
    assert.equal(settings.dshWorkdir, './data/agent-work');
    assert.equal(settings.dshToken, 'dsh-secret');
    assert.throws(() => store.update({ engine: 'bogus' as 'server-native' }), SettingsError);
    assert.throws(() => parseAgentSettingsPatch({ dshBaseUrl: 'not-a-url' }), SettingsError);
    const updated = store.update({ engine: 'server-native', dshWorkdir: '/srv/dsh' });
    assert.equal(updated.engine, 'server-native');
    assert.ok(readFileSync(config, 'utf8').includes('TTLAB_AGENT_ENGINE=server-native'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings store update rewrites the config file in place and preserves other keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-settings-'));
  const config = join(root, 'server.env');
  writeFileSync(config, configWith());
  try {
    const store = new SettingsStore(config);
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    const updated = store.update({ model: 'deepseek-reasoner', maxSessions: 12, apiKey: 'new-secret' });
    assert.equal(updated.model, 'deepseek-reasoner');
    assert.equal(notified, 1);

    const content = readFileSync(config, 'utf8');
    assert.ok(content.includes('TTLAB_AGENT_MODEL=deepseek-reasoner'));
    assert.ok(content.includes('TTLAB_AGENT_MAX_SESSIONS=12'));
    assert.ok(content.includes('TTLAB_DEEPSEEK_API_KEY=new-secret'));
    // unrelated keys and comments survive
    assert.ok(content.includes('TTLAB_SERVER_PORT=9000'));
    assert.ok(content.includes('TTLAB_TLS_REQUIRED=0'));
    assert.ok(content.includes('# Agent section'));
    // secrets are persisted with restricted permissions
    assert.equal(statSync(config).mode & 0o777, 0o600);

    // a fresh store over the same config restores the updated values
    const reloaded = new SettingsStore(config);
    assert.equal(reloaded.get().model, 'deepseek-reasoner');
    assert.equal(reloaded.get().apiKey, 'new-secret');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings store appends missing agent keys to the config file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-settings-'));
  const config = join(root, 'server.env');
  writeFileSync(config, 'TTLAB_SERVER_PORT=9000\n');
  try {
    const store = new SettingsStore(config);
    store.update({ enabled: true, agentToken: 'tok' });
    const content = readFileSync(config, 'utf8');
    assert.ok(content.includes('TTLAB_AGENT_ENABLED=1'));
    assert.ok(content.includes('TTLAB_AGENT_TOKEN=tok'));
    assert.ok(content.includes('TTLAB_SERVER_PORT=9000'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings store rejects invalid updates without changing state', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-settings-'));
  const config = join(root, 'server.env');
  writeFileSync(config, configWith());
  try {
    const store = new SettingsStore(config);
    assert.throws(() => store.update({ maxSessions: 0 }), SettingsError);
    assert.throws(() => store.update({ approvalTimeoutMs: 100 }), SettingsError);
    assert.throws(() => store.update({ model: '' }), SettingsError);
    assert.equal(store.get().maxSessions, 8);
    assert.ok(readFileSync(config, 'utf8').includes('TTLAB_AGENT_MAX_SESSIONS=8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings store falls back to defaults when the config file is corrupt', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-settings-'));
  const config = join(root, 'server.env');
  writeFileSync(config, 'TTLAB_AGENT_MAX_SESSIONS=not-a-number\n');
  try {
    const store = new SettingsStore(config);
    assert.equal(store.get().maxSessions, 8);
    assert.equal(store.get().enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseAgentSettingsPatch validates field types', () => {
  assert.throws(() => parseAgentSettingsPatch({ enabled: 'yes' }), SettingsError);
  assert.throws(() => parseAgentSettingsPatch({ model: '' }), SettingsError);
  assert.throws(() => parseAgentSettingsPatch({ llmUrl: 'not-a-url' }), SettingsError);
  assert.throws(() => parseAgentSettingsPatch({ maxSessions: 1.5 }), SettingsError);
  assert.throws(() => parseAgentSettingsPatch({ maxSessions: 101 }), SettingsError);
  assert.throws(() => parseAgentSettingsPatch(null), SettingsError);
  const patch = parseAgentSettingsPatch({ enabled: false, apiKey: '', agentToken: 'tok' });
  assert.equal(patch.enabled, false);
  assert.equal(patch.apiKey, '');
  assert.equal(patch.agentToken, 'tok');
});

test('settings view masks secrets', () => {
  const settings = { enabled: true, engine: 'server-native' as const, model: 'deepseek-chat', llmUrl: 'https://api.deepseek.com', apiKey: 'sk-abcdef1234', agentToken: 'tok', dshBaseUrl: 'http://127.0.0.1:9333', dshWorkdir: './data/agent-work', dshToken: 'dsh-tok', maxSessions: 8, approvalTimeoutMs: 60_000 };
  const view = toAgentSettingsView(settings);
  assert.equal(view.apiKeyConfigured, true);
  assert.equal(view.apiKeyHint, '…1234');
  assert.equal(view.agentTokenConfigured, true);
  assert.equal(view.dshTokenConfigured, true);
  assert.equal(view.engine, 'server-native');
  assert.equal('apiKey' in view, false);
  assert.equal('agentToken' in view, false);
  assert.equal('dshToken' in view, false);
});
