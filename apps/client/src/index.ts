import { arch, platform } from 'node:os';
import { ClientAgent } from './agent.js';
import {
  DEFAULT_CLIENT_CONFIG,
  loadJsonConfig,
  validateClientConfig,
  type ClientConfig,
} from '../../../packages/config/src/index.js';

const DEFAULT_CONFIG_PATH = '/var/lib/ttlab-client/client.json';

if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ event: 'client_self_check', status: 'ok', protocolVersion: '1.0', platform: platform(), architecture: arch() }));
  process.exit(0);
}

function parseConfigArgument(argv: string[]): { configPath: string; explicit: boolean } {
  const index = argv.indexOf('--config');
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error('--config requires a file path argument');
    return { configPath: value, explicit: true };
  }
  const inline = argv.find((arg) => arg.startsWith('--config='));
  if (inline) return { configPath: inline.slice('--config='.length), explicit: true };
  return { configPath: DEFAULT_CONFIG_PATH, explicit: false };
}

const { configPath, explicit } = parseConfigArgument(process.argv.slice(2));
const { config } = loadJsonConfig<ClientConfig>(configPath, DEFAULT_CLIENT_CONFIG, { requireFile: explicit, validate: validateClientConfig });

if (config.authEnabled && !config.token) throw new Error('token is required when client authentication is enabled');

const agent = new ClientAgent({
  serverUrl: config.serverUrl,
  token: config.token || undefined,
  clientId: config.clientId || undefined,
  clientVersion: config.clientVersion,
  stateDirectory: config.stateDirectory,
  heartbeatMs: config.heartbeatMs,
  refreshIntervalMs: config.refreshIntervalMs,
  serialTimeoutMs: config.serialTimeoutMs,
  controlSelector: config.controlSelector || undefined,
  logSelector: config.logSelector || undefined,
  probeEnabled: config.probeEnabled,
  updaterSocket: config.updaterSocket,
  serialBaudRate: config.serialBaudRate,
  tvBoxProfilePath: config.tvBoxProfilePath,
  debugDevices: config.debugDevices,
  dfu: config.dfu,
});

agent.start();
console.log(JSON.stringify({ event: 'client_started', clientId: agent.clientId, version: config.clientVersion }));
