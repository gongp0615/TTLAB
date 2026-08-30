import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'init-environment.sh');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile('bash', [scriptPath], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ exitCode: error ? (error.code as number) : 0, stdout, stderr });
    });
  });
}

const fakeNodeTemplate = (major: string, version: string): string => `#!/usr/bin/env bash
set -eu
case "\${1:-}" in
  -p) printf '%s\\n' "${major}"; exit 0 ;;
  --version|-v) printf '%s\\n' "${version}"; exit 0 ;;
esac
exit 0
`;

const fakeNpm = `#!/usr/bin/env bash
set -eu
case "\${1:-}" in
  --version|-v) printf '%s\\n' "10.9.2"; exit 0 ;;
esac
exit 0
`;

const fakeCurl = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TTLAB_FAKE_LOG"
out=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" || "$prev" == "--output" ]]; then out="$arg"; fi
  prev="$arg"
done
if [[ -n "$out" && -n "\${TTLAB_FAKE_TARBALL:-}" && -f "$TTLAB_FAKE_TARBALL" ]]; then
  cp "$TTLAB_FAKE_TARBALL" "$out"
fi
exit 0
`;

interface Harness {
  root: string;
  fakeBin: string;
  prefix: string;
  logPath: string;
  calls: () => string;
  run: (overrides?: Record<string, string>) => Promise<RunResult>;
  cleanup: () => void;
}

function makeHarness(options: { nodeMajor: string; nodeVersion: string }): Harness {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-init-'));
  const fakeBin = join(root, 'bin');
  const prefix = join(root, 'prefix');
  const logPath = join(root, 'curl-calls.log');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'node'), fakeNodeTemplate(options.nodeMajor, options.nodeVersion));
  writeFileSync(join(fakeBin, 'npm'), fakeNpm);
  writeFileSync(join(fakeBin, 'curl'), fakeCurl);
  chmodSync(join(fakeBin, 'node'), 0o755);
  chmodSync(join(fakeBin, 'npm'), 0o755);
  chmodSync(join(fakeBin, 'curl'), 0o755);
  const baseEnv: Record<string, string> = {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    TTLAB_SYSTEM_NODE: '1',
    TTLAB_NODE_PREFIX: prefix,
    TTLAB_FAKE_LOG: logPath,
    TTLAB_TEST_GROUPS: 'gongp adm dialout',
    TTLAB_UDEV_RULES_FILE: join(root, 'no-ttlab-rules'),
    HOME: root,
  };
  return {
    root,
    fakeBin,
    prefix,
    logPath,
    calls: () => {
      try {
        return readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    },
    run: (overrides) => runScript({ ...baseEnv, ...overrides }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeFakeTarball(version: string, arch: string, stagedParent: string, destination: string): void {
  const stagedDir = join(stagedParent, `node-v${version}-linux-${arch}`, 'bin');
  mkdirSync(stagedDir, { recursive: true });
  writeFileSync(join(stagedDir, 'node'), fakeNodeTemplate('22', `v${version}`));
  writeFileSync(join(stagedDir, 'npm'), fakeNpm);
  writeFileSync(join(stagedDir, 'npx'), fakeNpm);
  chmodSync(join(stagedDir, 'node'), 0o755);
  chmodSync(join(stagedDir, 'npm'), 0o755);
  chmodSync(join(stagedDir, 'npx'), 0o755);
  execFileSync('tar', ['-cJf', destination, '-C', stagedParent, `node-v${version}-linux-${arch}`]);
}

test('root mode skips installation when Node.js 22 and npm are already on PATH', async () => {
  const harness = makeHarness({ nodeMajor: '22', nodeVersion: 'v22.14.0' });
  try {
    const result = await harness.run();
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /already installed system-wide/);
    assert.equal(harness.calls().trim(), '', 'curl should not be invoked when Node is already present');
  } finally {
    harness.cleanup();
  }
});

test('root mode installs a newer Node.js when the existing version is too old', async () => {
  const harness = makeHarness({ nodeMajor: '20', nodeVersion: 'v20.18.0' });
  try {
    const version = '22.14.0';
    const tarball = join(harness.root, 'node.tar.xz');
    makeFakeTarball(version, 'x64', harness.root, tarball);
    const result = await harness.run({
      TTLAB_NODE_VERSION: version,
      TTLAB_NODE_ARCH: 'x64',
      TTLAB_FAKE_TARBALL: tarball,
    });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /installing Node\.js 22\.14\.0/);
    assert.ok(existsSync(join(harness.prefix, 'bin', 'node')), 'system-wide node symlink should exist');
    const resolved = execFileSync('readlink', [join(harness.prefix, 'bin', 'node')], { encoding: 'utf8' }).trim();
    assert.match(resolved, new RegExp(`node-v${version}-linux-x64/bin/node$`));
  } finally {
    harness.cleanup();
  }
});

test('root mode fails on an unsupported architecture', async () => {
  const harness = makeHarness({ nodeMajor: '22', nodeVersion: 'v22.14.0' });
  try {
    const result = await harness.run({ TTLAB_NODE_ARCH: 'riscv64' });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr + result.stdout, /unsupported Node\.js architecture: riscv64/);
  } finally {
    harness.cleanup();
  }
});

test('fails when the current user is not a member of the dialout group', async () => {
  const harness = makeHarness({ nodeMajor: '22', nodeVersion: 'v22.14.0' });
  try {
    const result = await harness.run({ TTLAB_TEST_GROUPS: 'gongp adm' });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr + result.stdout, /not in the dialout group/);
    assert.match(result.stderr + result.stdout, /sudo usermod -aG dialout/);
  } finally {
    harness.cleanup();
  }
});

test('proceeds when the current user is a member of the dialout group', async () => {
  const harness = makeHarness({ nodeMajor: '22', nodeVersion: 'v22.14.0' });
  try {
    const result = await harness.run({ TTLAB_TEST_GROUPS: 'gongp adm dialout' });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /current user is in the dialout group/);
  } finally {
    harness.cleanup();
  }
});

test('skips the dialout check when TTLAB_SKIP_DIALOUT=1 (Server-only run)', async () => {
  const harness = makeHarness({ nodeMajor: '22', nodeVersion: 'v22.14.0' });
  try {
    const result = await harness.run({ TTLAB_TEST_GROUPS: 'gongp adm', TTLAB_SKIP_DIALOUT: '1' });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /skipping dialout group check/);
  } finally {
    harness.cleanup();
  }
});

test('skips the dialout check when TTLAB udev rules are installed', async () => {
  const harness = makeHarness({ nodeMajor: '22', nodeVersion: 'v22.14.0' });
  try {
    const rulesPath = join(harness.root, 'installed-rules');
    writeFileSync(rulesPath, 'SUBSYSTEM=="tty", MODE="0666"\n');
    const result = await harness.run({ TTLAB_TEST_GROUPS: 'gongp adm', TTLAB_UDEV_RULES_FILE: rulesPath });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /serial access via TTLAB udev rules/);
  } finally {
    harness.cleanup();
  }
});
