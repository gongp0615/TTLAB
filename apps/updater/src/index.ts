import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:net';
import { arch, platform } from 'node:os';
import { existsSync, chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpdateRequest } from '../../../packages/protocol/src/index.js';

export interface LocalUpdateRequest extends UpdateRequest {
  downloadToken?: string;
}

export interface UpdaterConfig {
  stateDirectory: string;
  installRoot: string;
  publicKeyPem: string | undefined;
  skipRestart: boolean;
  runtimePlatform: string;
  runtimeArchitecture: string;
  runtimeProtocolVersion: string;
  allowInsecureDownloadUrl: boolean;
  fetchImpl: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
}

const defaultPublicKeyFile = process.env.TTLAB_UPDATE_PUBLIC_KEY_FILE;
const defaultPublicKey = process.env.TTLAB_UPDATE_PUBLIC_KEY ?? (defaultPublicKeyFile && existsSync(defaultPublicKeyFile) ? readFileSync(defaultPublicKeyFile, 'utf8') : undefined);

export const defaultConfig: UpdaterConfig = {
  stateDirectory: process.env.TTLAB_STATE_DIR ?? '/var/lib/ttlab-client',
  installRoot: process.env.TTLAB_INSTALL_ROOT ?? '/opt/ttlab/client',
  publicKeyPem: defaultPublicKey,
  skipRestart: process.env.TTLAB_SKIP_RESTART === '1',
  runtimePlatform: process.env.TTLAB_RUNTIME_PLATFORM ?? platform(),
  runtimeArchitecture: process.env.TTLAB_RUNTIME_ARCHITECTURE ?? arch(),
  runtimeProtocolVersion: process.env.TTLAB_RUNTIME_PROTOCOL_VERSION ?? '1.0',
  allowInsecureDownloadUrl: process.env.TTLAB_ALLOW_INSECURE_UPDATE_URL === '1',
  fetchImpl: fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function normalizeArchitecture(value: string): string {
  return ({ x64: 'amd64', amd64: 'amd64', arm64: 'arm64', aarch64: 'arm64', ia32: 'x86', x86: 'x86', arm: 'arm' } as Record<string, string>)[value] ?? value;
}

function versionParts(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  if (!actualParts || !minimumParts) return actual === minimum;
  if (actualParts[0] !== minimumParts[0]) return actualParts[0] > minimumParts[0];
  if (actualParts[1] !== minimumParts[1]) return actualParts[1] > minimumParts[1];
  if (actualParts[2] !== minimumParts[2]) return actualParts[2] > minimumParts[2];
  return true;
}

export function validateUpdateRequest(request: LocalUpdateRequest, config: UpdaterConfig = defaultConfig): void {
  if (!request.updateId || !request.version || !request.downloadUrl || !request.artifact || !request.sha256 || !request.signature || !request.platform || !request.architecture || !request.minProtocolVersion) throw new Error('invalid update request');
  if (!isSafeSegment(request.updateId) || !isSafeSegment(request.version) || !isSafeSegment(request.artifact)) throw new Error('invalid update path segment');
  if (!/^[a-f0-9]{64}$/i.test(request.sha256)) throw new Error('invalid artifact hash');
  if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) throw new Error('update request expired');
  if (!config.publicKeyPem) throw new Error('TTLAB_UPDATE_PUBLIC_KEY is required');
  if (request.platform !== config.runtimePlatform) throw new Error(`update platform ${request.platform} does not match ${config.runtimePlatform}`);
  if (normalizeArchitecture(request.architecture) !== normalizeArchitecture(config.runtimeArchitecture)) throw new Error(`update architecture ${request.architecture} does not match ${config.runtimeArchitecture}`);
  if (!versionAtLeast(config.runtimeProtocolVersion, request.minProtocolVersion)) throw new Error(`protocol ${config.runtimeProtocolVersion} is below required ${request.minProtocolVersion}`);
  const url = new URL(request.downloadUrl);
  if (url.protocol !== 'https:' && !config.allowInsecureDownloadUrl) throw new Error('update download URL must use HTTPS');
}

function writeStatus(config: UpdaterConfig, request: LocalUpdateRequest, state: string, message?: string): void {
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o750 });
  writeFileSync(join(config.stateDirectory, 'update-status.json'), JSON.stringify({ state, version: request.version, ...(message ? { message } : {}) }) + '\n', { mode: 0o660 });
}

function rollback(config: UpdaterConfig, currentLink: string, previousTarget: string): void {
  const temporaryLink = `${currentLink}.rollback`;
  rmSync(temporaryLink, { force: true });
  symlinkSync(previousTarget, temporaryLink, 'dir');
  rmSync(currentLink, { force: true });
  renameSync(temporaryLink, currentLink);
}

export async function performUpdate(request: LocalUpdateRequest, config: UpdaterConfig = defaultConfig): Promise<'healthy' | 'rolled_back'> {
  validateUpdateRequest(request, config);
  const releasesRoot = join(config.installRoot, 'releases');
  const currentLink = join(config.installRoot, 'current');
  const tempDirectory = join(releasesRoot, `.staging-${request.updateId}`);
  const targetDirectory = join(releasesRoot, request.version);
  let installed = false;
  try {
    writeStatus(config, request, 'downloading');
    const response = await config.fetchImpl(request.downloadUrl, { headers: { Authorization: `Bearer ${request.downloadToken ?? ''}` } });
    if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== request.sha256.toLowerCase()) throw new Error('artifact hash mismatch');

    writeStatus(config, request, 'verifying');
    const publicKey = createPublicKey(config.publicKeyPem as string);
    const signedText = `${request.version}\n${request.platform}\n${request.architecture}\n${request.sha256}`;
    if (!verify(null, Buffer.from(signedText), publicKey, Buffer.from(request.signature, 'base64'))) throw new Error('artifact signature mismatch');

    mkdirSync(tempDirectory, { recursive: true, mode: 0o755 });
    const archivePath = join(tempDirectory, basename(request.artifact));
    writeFileSync(archivePath, bytes, { mode: 0o640 });
    writeStatus(config, request, 'installing');
    const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
    if (listing.status !== 0 || listing.stdout.split('\n').some((entry) => entry.startsWith('/') || entry.includes('../') || entry.startsWith('..'))) throw new Error('unsafe or invalid update archive');
    const extraction = spawnSync('tar', ['-xzf', archivePath, '--no-same-owner', '-C', tempDirectory]);
    if (extraction.status !== 0) throw new Error('artifact extraction failed');
    rmSync(archivePath, { force: true });
    const clientBinary = join(tempDirectory, 'bin', 'ttlab-client');
    if (!existsSync(clientBinary)) throw new Error('artifact does not contain bin/ttlab-client');
    chmodSync(clientBinary, 0o755);
    const selfCheck = spawnSync(clientBinary, ['--check'], { encoding: 'utf8' });
    if (selfCheck.status !== 0) throw new Error('new client self-check failed');
    if (existsSync(targetDirectory)) throw new Error(`release already exists: ${request.version}`);
    renameSync(tempDirectory, targetDirectory);
    installed = true;

    const previousTarget = existsSync(currentLink) ? realpathSync(currentLink) : undefined;
    const temporaryLink = `${currentLink}.next`;
    rmSync(temporaryLink, { force: true });
    symlinkSync(targetDirectory, temporaryLink, 'dir');
    rmSync(currentLink, { force: true });
    renameSync(temporaryLink, currentLink);
    if (!config.skipRestart) {
      writeStatus(config, request, 'restarting');
      const restart = spawnSync('systemctl', ['restart', 'ttlab-client.service'], { encoding: 'utf8' });
      await config.sleep(5000);
      const health = restart.status === 0 ? spawnSync('systemctl', ['is-active', '--quiet', 'ttlab-client.service']) : restart;
      if (restart.status !== 0 || health.status !== 0) {
        if (previousTarget) {
          rollback(config, currentLink, previousTarget);
          writeStatus(config, request, 'rolled_back', 'new client failed health check; previous release restored');
          return 'rolled_back';
        }
        throw new Error('new client failed to restart and no previous release is available');
      }
    }
    writeStatus(config, request, 'healthy');
    return 'healthy';
  } catch (error) {
    if (!installed) rmSync(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function runSingle(request: LocalUpdateRequest, config: UpdaterConfig): Promise<void> {
  try {
    await performUpdate(request, config);
  } catch (error) {
    writeStatus(config, request, 'failed', error instanceof Error ? error.message : 'update failed');
  }
}

export function startUpdaterServer(socketPath: string, config: UpdaterConfig = defaultConfig): void {
  rmSync(socketPath, { force: true });
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o770 });
  let updateQueue = Promise.resolve();
  createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      let newline = input.indexOf('\n');
      while (newline >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          const request = JSON.parse(line) as LocalUpdateRequest;
          updateQueue = updateQueue.then(() => runSingle(request, config));
        } catch {
          socket.write('{"error":"invalid update request"}\n');
        }
        newline = input.indexOf('\n');
      }
    });
  }).listen(socketPath, () => {
    chmodSync(socketPath, 0o660);
    console.log(JSON.stringify({ event: 'updater_started', socketPath }));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  if (process.argv.includes('--serve')) {
    startUpdaterServer(process.env.TTLAB_UPDATER_SOCKET ?? '/run/ttlab-updater/update.sock');
  } else {
    const request = JSON.parse(process.argv[2] ?? '{}') as LocalUpdateRequest;
    runSingle(request, defaultConfig).catch(() => { process.exitCode = 1; });
  }
}
