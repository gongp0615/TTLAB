import { arch, platform } from 'node:os';
import { ClientAgent } from './agent.js';

const serverUrl = process.env.TTLAB_SERVER_URL ?? 'ws://127.0.0.1:9000/agent/v1/session';
const token = process.env.TTLAB_CLIENT_TOKEN?.trim() || undefined;
const clientAuthEnabled = process.env.TTLAB_CLIENT_AUTH_ENABLED === '1';
const stateDirectory = process.env.TTLAB_STATE_DIR ?? '/var/lib/ttlab-client';
const configuredClientId = process.env.TTLAB_CLIENT_ID?.trim() || undefined;
const clientVersion = process.env.TTLAB_CLIENT_VERSION ?? '0.1.0';
const heartbeatMs = Number(process.env.TTLAB_HEARTBEAT_MS ?? 10_000);
const updaterSocket = process.env.TTLAB_UPDATER_SOCKET ?? '/run/ttlab-updater/update.sock';

if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ event: 'client_self_check', status: 'ok', protocolVersion: '1.0', platform: platform(), architecture: arch() }));
  process.exit(0);
}

if (clientAuthEnabled && !token) throw new Error('TTLAB_CLIENT_TOKEN is required when client authentication is enabled');

const agent = new ClientAgent({
  serverUrl,
  token,
  clientId: configuredClientId,
  clientVersion,
  stateDirectory,
  heartbeatMs,
  refreshIntervalMs: 5_000,
  serialTimeoutMs: Number(process.env.TTLAB_SERIAL_TIMEOUT_MS ?? 3000),
  controlSelector: process.env.TTLAB_TVBOX_CONTROL_PORT,
  logSelector: process.env.TTLAB_TVBOX_LOG_PORT,
  probeEnabled: process.env.TTLAB_TVBOX_PROBE !== '0',
  updaterSocket,
});

agent.start();
console.log(JSON.stringify({ event: 'client_started', clientId: agent.clientId, version: clientVersion }));
