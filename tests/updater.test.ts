import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { performUpdate, validateUpdateRequest, type LocalUpdateRequest, type UpdaterConfig } from '../apps/updater/src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function config(root: string, overrides: Partial<UpdaterConfig> = {}): UpdaterConfig {
  return { stateDirectory: join(root, 'state'), installRoot: join(root, 'install'), publicKeyPem, skipRestart: true, runtimePlatform: process.platform, runtimeArchitecture: process.arch, runtimeProtocolVersion: '1.0', allowInsecureDownloadUrl: false, fetchImpl: fetch, sleep: async () => undefined, ...overrides };
}

function request(version: string, bytes: Buffer, overrides: Partial<LocalUpdateRequest> = {}): LocalUpdateRequest {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const platform = process.platform;
  const architecture = process.arch;
  const signature = sign(null, Buffer.from(`${version}\n${platform}\n${architecture}\n${sha256}`), privateKey).toString('base64');
  return { updateId: `upd-${version}`, version, platform, architecture, artifact: 'client.tar.gz', sha256, signature, minProtocolVersion: '1.0', downloadUrl: 'https://updates.example/client.tar.gz', expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides };
}

test('updater rejects incompatible architecture and minimum protocol', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-updater-'));
  try {
    const base = request('1.0.1', Buffer.from('unused'));
    assert.throws(() => validateUpdateRequest({ ...base, architecture: 'mips64' }, config(root)), /architecture/);
    assert.throws(() => validateUpdateRequest({ ...base, minProtocolVersion: '2.0' }, config(root)), /below required/);
    assert.throws(() => validateUpdateRequest({ ...base, downloadUrl: 'http://updates.example/client.tar.gz' }, config(root)), /HTTPS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed post-restart health check restores the previous release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-updater-'));
  const oldPath = join(root, 'install', 'releases', '1.0.0');
  const source = join(root, 'source', 'bin');
  const fakeBin = join(root, 'fake-bin');
  const oldCurrent = join(root, 'install', 'current');
  const archive = join(root, 'client.tar.gz');
  const oldPathEnv = process.env.PATH;
  try {
    mkdirSync(join(oldPath, 'bin'), { recursive: true });
    writeFileSync(join(oldPath, 'bin', 'marker'), 'old');
    mkdirSync(source, { recursive: true });
    const binary = join(source, 'ttlab-client');
    writeFileSync(binary, '#!/bin/sh\n[ "$1" = "--check" ]\n');
    chmodSync(binary, 0o755);
    execFileSync('tar', ['-czf', archive, '-C', join(root, 'source'), 'bin']);
    mkdirSync(fakeBin, { recursive: true });
    const systemctl = join(fakeBin, 'systemctl');
    writeFileSync(systemctl, '#!/bin/sh\n[ "$1" = "restart" ] && exit 0\nexit 1\n');
    chmodSync(systemctl, 0o755);
    process.env.PATH = `${fakeBin}:${oldPathEnv ?? ''}`;
    mkdirSync(join(oldPath, '..'), { recursive: true });
    symlinkSync(oldPath, oldCurrent, 'dir');
    const bytes = readFileSync(archive);
    const result = await performUpdate(request('1.0.1', bytes), config(root, { skipRestart: false, sleep: async () => undefined, fetchImpl: async () => new Response(bytes) }));
    assert.equal(result, 'rolled_back');
    assert.equal(realpathSync(oldCurrent), oldPath);
    assert.equal(JSON.parse(readFileSync(join(root, 'state', 'update-status.json'), 'utf8')).state, 'rolled_back');
  } finally {
    process.env.PATH = oldPathEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('updater runs the client self-check before installing a release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-updater-'));
  try {
    const source = join(root, 'source', 'bin');
    const archive = join(root, 'client.tar.gz');
    mkdirSync(source, { recursive: true });
    const binary = join(source, 'ttlab-client');
    writeFileSync(binary, '#!/bin/sh\nexit 1\n');
    chmodSync(binary, 0o755);
    execFileSync('tar', ['-czf', archive, '-C', join(root, 'source'), 'bin']);
    const bytes = readFileSync(archive);
    await assert.rejects(() => performUpdate(request('1.0.2', bytes), config(root, { fetchImpl: async () => new Response(bytes) })), /self-check/);
    assert.equal(realpathSafe(join(root, 'install', 'current')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function realpathSafe(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}
