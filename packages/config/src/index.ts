import { existsSync, readFileSync } from 'node:fs';

export interface ClientDfuConfig {
  utilPath: string;
  vid: string;
  pid: string;
}

export interface ClientConfig {
  serverUrl: string;
  clientId: string;
  token: string;
  authEnabled: boolean;
  stateDirectory: string;
  clientVersion: string;
  heartbeatMs: number;
  refreshIntervalMs: number;
  serialTimeoutMs: number;
  controlSelector: string;
  logSelector: string;
  probeEnabled: boolean;
  updaterSocket: string;
  serialBaudRate: string;
  tvBoxProfilePath: string;
  debugDevices: boolean;
  dfu: ClientDfuConfig;
}

export interface UpdaterConfig {
  stateDirectory: string;
  installRoot: string;
  publicKeyFile: string;
  skipRestart: boolean;
  runtimePlatform: string;
  runtimeArchitecture: string;
  runtimeProtocolVersion: string;
  allowInsecureDownloadUrl: boolean;
  socketPath: string;
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  serverUrl: 'ws://127.0.0.1:9000/agent/v1/session',
  clientId: '',
  token: '',
  authEnabled: false,
  stateDirectory: '/var/lib/ttlab-client',
  clientVersion: '0.1.0',
  heartbeatMs: 10_000,
  refreshIntervalMs: 5_000,
  serialTimeoutMs: 3_000,
  controlSelector: '',
  logSelector: '',
  probeEnabled: true,
  updaterSocket: '/run/ttlab-updater/update.sock',
  serialBaudRate: '115200',
  tvBoxProfilePath: './device-types/tv-stick-test-box/device.json',
  debugDevices: false,
  dfu: { utilPath: 'dfu-util', vid: '28e9', pid: '018a' },
};

export const DEFAULT_UPDATER_CONFIG: UpdaterConfig = {
  stateDirectory: '/var/lib/ttlab-client',
  installRoot: '/opt/ttlab/client',
  publicKeyFile: '/etc/ttlab/update-public.pem',
  skipRestart: false,
  runtimePlatform: '',
  runtimeArchitecture: '',
  runtimeProtocolVersion: '1.0',
  allowInsecureDownloadUrl: false,
  socketPath: '/run/ttlab-updater/update.sock',
};

export interface LoadConfigOptions<T> {
  /** 显式指定配置文件（--config）时为 true：文件缺失直接报错；默认路径缺失则告警并返回默认值 */
  requireFile?: boolean | undefined;
  validate?: ((config: T) => string[]) | undefined;
}

export interface LoadedConfig<T> {
  config: T;
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeWithDefaults<T extends object>(parsed: Record<string, unknown>, defaults: T): T {
  const defaultsRecord = defaults as Record<string, unknown>;
  const result: Record<string, unknown> = { ...defaultsRecord };
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    const defaultEntry = defaultsRecord[key];
    if (isRecord(value) && isRecord(defaultEntry)) {
      result[key] = mergeWithDefaults(value, defaultEntry);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export function loadJsonConfig<T extends object>(filePath: string, defaults: T, options: LoadConfigOptions<T> = {}): LoadedConfig<T> {
  if (!existsSync(filePath)) {
    if (options.requireFile) throw new Error(`config file not found: ${filePath}`);
    console.warn(JSON.stringify({ event: 'config_missing', path: filePath, usingDefaults: true }));
    return { config: structuredClone(defaults), path: filePath };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`config file ${filePath} must contain a JSON object`);
  const config = mergeWithDefaults(parsed, defaults);
  const errors = options.validate ? options.validate(config) : [];
  if (errors.length > 0) {
    throw new Error(`invalid config file ${filePath}:\n- ${errors.join('\n- ')}`);
  }
  return { config, path: filePath };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function validateClientConfig(config: ClientConfig): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(config.serverUrl)) errors.push('serverUrl must be a non-empty string');
  else if (!/^wss?:\/\//.test(config.serverUrl)) errors.push('serverUrl must start with ws:// or wss://');
  if (!isString(config.clientId)) errors.push('clientId must be a string');
  if (!isString(config.token)) errors.push('token must be a string');
  if (config.authEnabled && config.token.length === 0) errors.push('token is required when authEnabled is true');
  if (!isNonEmptyString(config.stateDirectory)) errors.push('stateDirectory must be a non-empty string');
  if (!isString(config.clientVersion)) errors.push('clientVersion must be a string');
  if (!isFiniteNumber(config.heartbeatMs) || config.heartbeatMs <= 0) errors.push('heartbeatMs must be a positive number');
  if (!isFiniteNumber(config.refreshIntervalMs) || config.refreshIntervalMs <= 0) errors.push('refreshIntervalMs must be a positive number');
  if (!isFiniteNumber(config.serialTimeoutMs) || config.serialTimeoutMs <= 0) errors.push('serialTimeoutMs must be a positive number');
  if (!isString(config.controlSelector)) errors.push('controlSelector must be a string');
  if (!isString(config.logSelector)) errors.push('logSelector must be a string');
  if (!isBoolean(config.probeEnabled)) errors.push('probeEnabled must be a boolean');
  if (!isNonEmptyString(config.updaterSocket)) errors.push('updaterSocket must be a non-empty string');
  if (!isNonEmptyString(config.serialBaudRate)) errors.push('serialBaudRate must be a non-empty string');
  if (!isNonEmptyString(config.tvBoxProfilePath)) errors.push('tvBoxProfilePath must be a non-empty string');
  if (!isBoolean(config.debugDevices)) errors.push('debugDevices must be a boolean');
  const dfu = config.dfu;
  if (!isRecord(dfu)) errors.push('dfu must be an object');
  else {
    if (!isNonEmptyString(dfu.utilPath)) errors.push('dfu.utilPath must be a non-empty string');
    if (!isNonEmptyString(dfu.vid)) errors.push('dfu.vid must be a non-empty string');
    if (!isNonEmptyString(dfu.pid)) errors.push('dfu.pid must be a non-empty string');
  }
  return errors;
}

export function validateUpdaterConfig(config: UpdaterConfig): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(config.stateDirectory)) errors.push('stateDirectory must be a non-empty string');
  if (!isNonEmptyString(config.installRoot)) errors.push('installRoot must be a non-empty string');
  if (!isNonEmptyString(config.publicKeyFile)) errors.push('publicKeyFile must be a non-empty string');
  if (!isBoolean(config.skipRestart)) errors.push('skipRestart must be a boolean');
  if (!isString(config.runtimePlatform)) errors.push('runtimePlatform must be a string');
  if (!isString(config.runtimeArchitecture)) errors.push('runtimeArchitecture must be a string');
  if (!isString(config.runtimeProtocolVersion)) errors.push('runtimeProtocolVersion must be a string');
  if (!isBoolean(config.allowInsecureDownloadUrl)) errors.push('allowInsecureDownloadUrl must be a boolean');
  if (!isNonEmptyString(config.socketPath)) errors.push('socketPath must be a non-empty string');
  return errors;
}
