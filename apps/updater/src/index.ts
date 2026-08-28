import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { UpdateRequest } from '../../../packages/protocol/src/index.js';

interface LocalUpdateRequest extends UpdateRequest {
  downloadToken?: string;
}

const stateDirectory = process.env.TTLAB_STATE_DIR ?? '/var/lib/ttlab-client';
const installRoot = process.env.TTLAB_INSTALL_ROOT ?? '/opt/ttlab/client';
const publicKeyFile = process.env.TTLAB_UPDATE_PUBLIC_KEY_FILE;
const publicKeyPem = process.env.TTLAB_UPDATE_PUBLIC_KEY ?? (publicKeyFile && existsSync(publicKeyFile) ? readFileSync(publicKeyFile, 'utf8') : undefined);
const skipRestart = process.env.TTLAB_SKIP_RESTART === '1';
const socketPath = process.env.TTLAB_UPDATER_SOCKET ?? '/run/ttlab-updater/update.sock';
const statusPath = join(stateDirectory, 'update-status.json');
const releasesRoot = join(installRoot, 'releases');
const currentLink = join(installRoot, 'current');
let updateQueue = Promise.resolve();

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function status(request: LocalUpdateRequest, state: string, message?: string): void {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o750 });
  writeFileSync(statusPath, JSON.stringify({ state, version: request.version, ...(message ? { message } : {}) }) + '\n', { mode: 0o660 });
}

function validateRequest(request: LocalUpdateRequest): void {
  if (!request.updateId || !request.version || !request.downloadUrl || !request.sha256 || !request.signature) throw new Error('invalid update request');
  if (!isSafeSegment(request.updateId) || !isSafeSegment(request.version) || !isSafeSegment(request.artifact)) throw new Error('invalid update path segment');
  if (!/^[a-f0-9]{64}$/i.test(request.sha256)) throw new Error('invalid artifact hash');
  if (Date.parse(request.expiresAt) <= Date.now()) throw new Error('update request expired');
  if (!publicKeyPem) throw new Error('TTLAB_UPDATE_PUBLIC_KEY is required');
}

async function performUpdate(request: LocalUpdateRequest): Promise<void> {
  validateRequest(request);
  status(request, 'downloading');
  const response = await fetch(request.downloadUrl, { headers: { Authorization: `Bearer ${request.downloadToken ?? ''}` } });
  if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== request.sha256.toLowerCase()) throw new Error('artifact hash mismatch');

  status(request, 'verifying');
  const publicKey = createPublicKey(publicKeyPem ?? '');
  const signedText = `${request.version}\n${request.platform}\n${request.architecture}\n${request.sha256}`;
  if (!verify(null, Buffer.from(signedText), publicKey, Buffer.from(request.signature, 'base64'))) throw new Error('artifact signature mismatch');

  const tempDirectory = join(releasesRoot, `.staging-${request.updateId}`);
  const targetDirectory = join(releasesRoot, request.version);
  mkdirSync(tempDirectory, { recursive: true, mode: 0o755 });
  const archivePath = join(tempDirectory, basename(request.artifact));
  writeFileSync(archivePath, bytes, { mode: 0o640 });
  status(request, 'installing');
  const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (listing.status !== 0 || listing.stdout.split('\n').some((entry) => entry.startsWith('/') || entry.includes('../'))) throw new Error('unsafe or invalid update archive');
  const extraction = spawnSync('tar', ['-xzf', archivePath, '--no-same-owner', '-C', tempDirectory]);
  if (extraction.status !== 0) throw new Error('artifact extraction failed');
  rmSync(archivePath, { force: true });
  if (!existsSync(join(tempDirectory, 'bin', 'ttlab-client'))) throw new Error('artifact does not contain bin/ttlab-client');
  if (existsSync(targetDirectory)) rmSync(targetDirectory, { recursive: true, force: true });
  renameSync(tempDirectory, targetDirectory);

  const previousTarget = existsSync(currentLink) ? realpathSync(currentLink) : undefined;
  const temporaryLink = `${currentLink}.next`;
  rmSync(temporaryLink, { force: true });
  symlinkSync(targetDirectory, temporaryLink, 'dir');
  renameSync(temporaryLink, currentLink);
  if (!skipRestart) {
    status(request, 'restarting');
    const restart = spawnSync('systemctl', ['restart', 'ttlab-client.service'], { encoding: 'utf8' });
    if (restart.status !== 0) throw new Error('new client failed to restart');
    await wait(5000);
    const health = spawnSync('systemctl', ['is-active', '--quiet', 'ttlab-client.service']);
    if (health.status !== 0 && previousTarget) {
      rmSync(currentLink, { force: true });
      symlinkSync(previousTarget, currentLink, 'dir');
      spawnSync('systemctl', ['restart', 'ttlab-client.service']);
      status(request, 'rolled_back', 'new client was not active after restart');
      return;
    }
  }
  status(request, 'healthy');
}

async function runSingle(request: LocalUpdateRequest): Promise<void> {
  try {
    await performUpdate(request);
  } catch (error) {
    status(request, 'failed', error instanceof Error ? error.message : 'update failed');
  }
}

if (process.argv.includes('--serve')) {
  rmSync(socketPath, { force: true });
  mkdirSync(join(socketPath, '..'), { recursive: true, mode: 0o770 });
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
          updateQueue = updateQueue.then(() => runSingle(request));
        } catch {
          socket.write('{"error":"invalid update request"}\n');
        }
        newline = input.indexOf('\n');
      }
    });
  }).listen(socketPath, () => console.log(JSON.stringify({ event: 'updater_started', socketPath })));
} else {
  const request = JSON.parse(process.argv[2] ?? '{}') as LocalUpdateRequest;
  runSingle(request).catch(() => process.exitCode = 1);
}
