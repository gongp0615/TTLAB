import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface AgentSettings {
  enabled: boolean;
  engine: 'server-native' | 'dsh';
  model: string;
  llmUrl: string;
  apiKey: string;
  agentToken: string;
  dshBaseUrl: string;
  dshWorkdir: string;
  dshToken: string;
  maxSessions: number;
  approvalTimeoutMs: number;
}

export interface AgentSettingsView {
  enabled: boolean;
  engine: 'server-native' | 'dsh';
  model: string;
  llmUrl: string;
  maxSessions: number;
  approvalTimeoutMs: number;
  dshBaseUrl: string;
  dshWorkdir: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  agentTokenConfigured: boolean;
  dshTokenConfigured: boolean;
}

export interface AgentSettingsPatch {
  enabled?: boolean;
  engine?: 'server-native' | 'dsh';
  model?: string;
  llmUrl?: string;
  maxSessions?: number;
  approvalTimeoutMs?: number;
  apiKey?: string;
  agentToken?: string;
  dshBaseUrl?: string;
  dshWorkdir?: string;
  dshToken?: string;
}

export class SettingsError extends Error {}

const MAX_SESSIONS_LIMIT = 100;
const MAX_APPROVAL_TIMEOUT_MS = 3_600_000;

const agentConfigKeys = [
  ['enabled', 'TTLAB_AGENT_ENABLED'],
  ['engine', 'TTLAB_AGENT_ENGINE'],
  ['model', 'TTLAB_AGENT_MODEL'],
  ['llmUrl', 'TTLAB_AGENT_LLM_URL'],
  ['apiKey', 'TTLAB_DEEPSEEK_API_KEY'],
  ['agentToken', 'TTLAB_AGENT_TOKEN'],
  ['dshBaseUrl', 'TTLAB_DSH_BASE_URL'],
  ['dshWorkdir', 'TTLAB_DSH_WORKDIR'],
  ['dshToken', 'TTLAB_DSH_TOKEN'],
  ['maxSessions', 'TTLAB_AGENT_MAX_SESSIONS'],
  ['approvalTimeoutMs', 'TTLAB_AGENT_APPROVAL_TIMEOUT_MS'],
] as const;

type AgentField = (typeof agentConfigKeys)[number][0];

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

export function defaultAgentSettings(): AgentSettings {
  return {
    enabled: false,
    engine: 'server-native',
    model: 'deepseek-chat',
    llmUrl: 'https://api.deepseek.com',
    apiKey: '',
    agentToken: '',
    dshBaseUrl: 'http://127.0.0.1:9333',
    dshWorkdir: './data/agent-work',
    dshToken: '',
    maxSessions: 8,
    approvalTimeoutMs: 60_000,
  };
}

export function parseAgentSettingsPatch(value: unknown): AgentSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError('settings must be an object');
  const record = value as Record<string, unknown>;
  const patch: AgentSettingsPatch = {};
  if ('enabled' in record) {
    if (typeof record.enabled !== 'boolean') throw new SettingsError('enabled must be a boolean');
    patch.enabled = record.enabled;
  }
  if ('engine' in record) {
    if (record.engine !== 'server-native' && record.engine !== 'dsh') throw new SettingsError('engine must be "server-native" or "dsh"');
    patch.engine = record.engine;
  }
  if ('model' in record) {
    if (typeof record.model !== 'string' || record.model.trim().length === 0) throw new SettingsError('model must be a non-empty string');
    patch.model = record.model.trim();
  }
  if ('llmUrl' in record) {
    if (typeof record.llmUrl !== 'string') throw new SettingsError('llmUrl must be a string');
    const trimmed = record.llmUrl.trim();
    if (trimmed.length > 0 && !/^https?:\/\//.test(trimmed)) throw new SettingsError('llmUrl must start with http:// or https://');
    patch.llmUrl = trimmed;
  }
  if ('apiKey' in record) {
    if (typeof record.apiKey !== 'string') throw new SettingsError('apiKey must be a string');
    patch.apiKey = record.apiKey.trim();
  }
  if ('agentToken' in record) {
    if (typeof record.agentToken !== 'string') throw new SettingsError('agentToken must be a string');
    patch.agentToken = record.agentToken.trim();
  }
  if ('dshBaseUrl' in record) {
    if (typeof record.dshBaseUrl !== 'string') throw new SettingsError('dshBaseUrl must be a string');
    const trimmed = record.dshBaseUrl.trim();
    if (trimmed.length > 0 && !/^https?:\/\//.test(trimmed)) throw new SettingsError('dshBaseUrl must start with http:// or https://');
    patch.dshBaseUrl = trimmed;
  }
  if ('dshWorkdir' in record) {
    if (typeof record.dshWorkdir !== 'string') throw new SettingsError('dshWorkdir must be a string');
    patch.dshWorkdir = record.dshWorkdir.trim();
  }
  if ('dshToken' in record) {
    if (typeof record.dshToken !== 'string') throw new SettingsError('dshToken must be a string');
    patch.dshToken = record.dshToken.trim();
  }
  if ('maxSessions' in record) {
    if (!Number.isInteger(record.maxSessions) || (record.maxSessions as number) < 1 || (record.maxSessions as number) > MAX_SESSIONS_LIMIT) {
      throw new SettingsError(`maxSessions must be an integer between 1 and ${MAX_SESSIONS_LIMIT}`);
    }
    patch.maxSessions = record.maxSessions as number;
  }
  if ('approvalTimeoutMs' in record) {
    if (!Number.isInteger(record.approvalTimeoutMs) || (record.approvalTimeoutMs as number) < 1000 || (record.approvalTimeoutMs as number) > MAX_APPROVAL_TIMEOUT_MS) {
      throw new SettingsError('approvalTimeoutMs must be an integer between 1000 and 3600000');
    }
    patch.approvalTimeoutMs = record.approvalTimeoutMs as number;
  }
  return patch;
}

export function validateAgentSettings(settings: AgentSettings): void {
  if (typeof settings.enabled !== 'boolean') throw new SettingsError('enabled must be a boolean');
  if (settings.engine !== 'server-native' && settings.engine !== 'dsh') throw new SettingsError('engine must be "server-native" or "dsh"');
  if (typeof settings.model !== 'string' || settings.model.trim().length === 0) throw new SettingsError('model must be a non-empty string');
  if (typeof settings.llmUrl !== 'string') throw new SettingsError('llmUrl must be a string');
  if (typeof settings.apiKey !== 'string') throw new SettingsError('apiKey must be a string');
  if (typeof settings.agentToken !== 'string') throw new SettingsError('agentToken must be a string');
  if (typeof settings.dshBaseUrl !== 'string') throw new SettingsError('dshBaseUrl must be a string');
  if (typeof settings.dshWorkdir !== 'string') throw new SettingsError('dshWorkdir must be a string');
  if (typeof settings.dshToken !== 'string') throw new SettingsError('dshToken must be a string');
  if (!Number.isInteger(settings.maxSessions) || settings.maxSessions < 1 || settings.maxSessions > MAX_SESSIONS_LIMIT) throw new SettingsError('invalid maxSessions');
  if (!Number.isInteger(settings.approvalTimeoutMs) || settings.approvalTimeoutMs < 1000 || settings.approvalTimeoutMs > MAX_APPROVAL_TIMEOUT_MS) throw new SettingsError('invalid approvalTimeoutMs');
}

export function toAgentSettingsView(settings: AgentSettings): AgentSettingsView {
  return {
    enabled: settings.enabled,
    engine: settings.engine,
    model: settings.model,
    llmUrl: settings.llmUrl,
    maxSessions: settings.maxSessions,
    approvalTimeoutMs: settings.approvalTimeoutMs,
    dshBaseUrl: settings.dshBaseUrl,
    dshWorkdir: settings.dshWorkdir,
    apiKeyConfigured: settings.apiKey.length > 0,
    apiKeyHint: settings.apiKey.length > 4 ? `…${settings.apiKey.slice(-4)}` : '',
    agentTokenConfigured: settings.agentToken.length > 0,
    dshTokenConfigured: settings.dshToken.length > 0,
  };
}

/**
 * Reads and writes agent settings from the TTLAB config file (server.env).
 * The config file is the single source of truth; environment variables are not used.
 */
export class SettingsStore {
  private current: AgentSettings;
  private readonly observers = new Set<() => void>();

  constructor(private readonly configFilePath: string) {
    this.current = defaultAgentSettings();
    this.load();
  }

  get(): AgentSettings {
    return { ...this.current };
  }

  update(patch: AgentSettingsPatch): AgentSettings {
    const next: AgentSettings = { ...this.current, ...patch };
    validateAgentSettings(next);
    this.current = next;
    this.persistToConfig();
    for (const observer of this.observers) observer();
    return this.get();
  }

  subscribe(observer: () => void): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  private load(): void {
    if (!existsSync(this.configFilePath)) return;
    try {
      const values = new Map<string, string>();
      for (const rawLine of readFileSync(this.configFilePath, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim();
        if (!/^TTLAB_[A-Z0-9_]+$/.test(key)) continue;
        values.set(key, unquote(line.slice(separator + 1).trim()));
      }
      const merged = defaultAgentSettings();
      for (const [field, key] of agentConfigKeys) {
        const value = values.get(key);
        if (value === undefined) continue;
        this.applyValue(merged, field, value);
      }
      validateAgentSettings(merged);
      this.current = merged;
    } catch (error) {
      console.error(JSON.stringify({ event: 'settings_load_failed', message: error instanceof Error ? error.message : 'invalid config file' }));
    }
  }

  private applyValue(settings: AgentSettings, field: AgentField, value: string): void {
    switch (field) {
      case 'enabled':
        settings.enabled = value === '1';
        break;
      case 'engine':
        if (value === 'server-native' || value === 'dsh') settings.engine = value;
        break;
      case 'model':
        settings.model = value;
        break;
      case 'llmUrl':
        settings.llmUrl = value;
        break;
      case 'apiKey':
        settings.apiKey = value;
        break;
      case 'agentToken':
        settings.agentToken = value;
        break;
      case 'dshBaseUrl':
        settings.dshBaseUrl = value;
        break;
      case 'dshWorkdir':
        settings.dshWorkdir = value;
        break;
      case 'dshToken':
        settings.dshToken = value;
        break;
      case 'maxSessions': {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) settings.maxSessions = parsed;
        break;
      }
      case 'approvalTimeoutMs': {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) settings.approvalTimeoutMs = parsed;
        break;
      }
    }
  }

  private persistToConfig(): void {
    const entries = new Map<string, string>(agentConfigKeys.map(([field, key]) => [key, this.configValue(field)] as const));
    if (!existsSync(this.configFilePath)) {
      writeFileSync(this.configFilePath, this.agentSectionText([...entries]), { mode: 0o600 });
      chmodSync(this.configFilePath, 0o600);
      return;
    }
    const lines = readFileSync(this.configFilePath, 'utf8').split(/\r?\n/);
    const seen = new Set<string>();
    const output: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const separator = trimmed.indexOf('=');
      if (!trimmed.startsWith('#') && separator > 0) {
        const key = trimmed.slice(0, separator).trim();
        if (entries.has(key)) {
          output.push(`${key}=${entries.get(key)}`);
          seen.add(key);
          continue;
        }
      }
      output.push(line);
    }
    const missing = [...entries].filter(([key]) => !seen.has(key));
    if (missing.length > 0) {
      if (output.length > 0 && output[output.length - 1]?.trim() !== '') output.push('');
      output.push(...this.agentSectionText(missing).split('\n'));
    }
    writeFileSync(this.configFilePath, `${output.join('\n')}\n`, { mode: 0o600 });
    chmodSync(this.configFilePath, 0o600);
  }

  private agentSectionText(entries: ReadonlyArray<readonly [string, string]>): string {
    const lines = ['', '# Agent / model settings (managed by the Web console).'];
    for (const [key, value] of entries) lines.push(`${key}=${value}`);
    return `${lines.join('\n')}\n`;
  }

  private configValue(field: AgentField): string {
    switch (field) {
      case 'enabled':
        return this.current.enabled ? '1' : '0';
      case 'maxSessions':
        return String(this.current.maxSessions);
      case 'approvalTimeoutMs':
        return String(this.current.approvalTimeoutMs);
      default:
        return this.current[field];
    }
  }
}
