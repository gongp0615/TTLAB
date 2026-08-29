import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'serial-attach.sh');

const usbipdListFixture = `Connected:\r
BUSID  VID:PID    DEVICE                                                        STATE\r
1-3    248d:5b5f  USB Input Device                                              Not shared\r
2-4    1a86:7523  USB-SERIAL CH340 (COM8)                                       Not shared\r
2-5    28e9:018a  USB Serial Device (COM6)                                      Shared\r
2-6    10c4:ea70  Enhanced Com Port, Standard Com Port                          Shared\r
2-7    28e9:018a  USB Serial Device (COM7)                                      Not shared\r
3-1    28e9:018a  USB Serial Device (COM9)                                      Attached\r
\r
Persisted:\r
GUID                                  DEVICE\r
`;

const fakeUsbipd = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TTLAB_FAKE_LOG"
cmd="\${1:-}"; shift || true
STATE_FILE="\${TTLAB_FAKE_STATE:-}"
case "$cmd" in
  list)
    attached=""
    if [ -n "$STATE_FILE" ] && [ -f "$STATE_FILE" ]; then
      attached=$(tr '\\n' ' ' < "$STATE_FILE")
    fi
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      busid=$(printf '%s\\n' "$line" | awk '{print $1}')
      if printf '%s' "$attached" | grep -q "$busid"; then
        printf '%s\\n' "$line" | sed -E 's/[[:space:]]+Shared[[:space:]]*$/ Attached/'
      else
        printf '%s\\n' "$line"
      fi
    done <<'FIXTURE'
${usbipdListFixture}
FIXTURE
    ;;
  attach)
    busid=""
    for a in "$@"; do
      case "$a" in --busid=*) busid="\${a#--busid=}";; esac
    done
    if [ "\${TTLAB_FAKE_ATTACH_CREATES_NODE:-1}" != "0" ]; then
      mkdir -p "$TTLAB_FAKE_DEV"
      touch "$TTLAB_FAKE_DEV/ttyUSB0"
    fi
    if [ -n "$STATE_FILE" ]; then
      printf '%s\\n' "$busid" >> "$STATE_FILE"
    fi
    printf 'attach-ok %s\\n' "$*"
    ;;
  bind)
    printf 'bind-ok %s\\n' "$*"
    ;;
esac
`;

const deviceTypeProfile = `{
  "type": "tv-stick-test-box",
  "displayName": "TV Stick Test Box",
  "match": [
    { "vendorId": "28e9", "productId": "018a" },
    { "vendorId": "10c4", "productId": "ea70" }
  ],
  "capabilities": []
}
`;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile('bash', [scriptPath, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ exitCode: error ? (error.code as number) : 0, stdout, stderr });
    });
  });
}

interface Harness {
  root: string;
  logPath: string;
  devDir: string;
  calls: () => string;
  run: (args: string[], overrides?: Record<string, string>) => Promise<RunResult>;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-serial-attach-'));
  const deviceTypesDir = join(root, 'device-types');
  const devDir = join(root, 'dev');
  const fakeUsbipdPath = join(root, 'usbipd');
  const logPath = join(root, 'calls.log');
  const statePath = join(root, 'attach-state.txt');
  mkdirSync(deviceTypesDir);
  mkdirSync(devDir);
  writeFileSync(join(deviceTypesDir, 'tv-stick-test-box.json'), deviceTypeProfile);
  writeFileSync(fakeUsbipdPath, fakeUsbipd);
  chmodSync(fakeUsbipdPath, 0o755);
  const baseEnv = {
    TTLAB_WSL_DETECTED: '1',
    TTLAB_USBIPD_EXE: fakeUsbipdPath,
    TTLAB_DEVICE_TYPES_DIR: deviceTypesDir,
    TTLAB_WSL_SERIAL_DEV_DIR: devDir,
    TTLAB_WSL_SERIAL_ELEVATE: '0',
    TTLAB_WSL_SERIAL_TIMEOUT_SECONDS: '10',
    TTLAB_WSL_SERIAL_WAIT_SECONDS: '1',
    TTLAB_FAKE_LOG: logPath,
    TTLAB_FAKE_DEV: devDir,
    TTLAB_FAKE_STATE: statePath,
  };
  return {
    root,
    logPath,
    devDir,
    calls: () => {
      try {
        return readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    },
    run: (args, overrides) => runScript(args, { ...baseEnv, ...overrides }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('status classifies known, unknown, attached and non-serial devices', async () => {
  const harness = makeHarness();
  try {
    const result = await harness.run(['status']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /configured device type VID:PID set: 28e9:018a 10c4:ea70/);
    assert.match(result.stdout, /2-5\s+28e9:018a\s+.*\(known type, NEEDS ATTACH\)/);
    assert.match(result.stdout, /2-6\s+10c4:ea70\s+.*\(known type, NEEDS ATTACH\)/);
    assert.match(result.stdout, /2-7\s+28e9:018a\s+.*\(known type, not shared\)/);
    assert.match(result.stdout, /3-1\s+28e9:018a\s+.*\(known type, attached\)/);
    assert.match(result.stdout, /2-4\s+1a86:7523\s+.*\(unknown type, ignored\)/);
    assert.match(result.stdout, /1-3\s+248d:5b5f\s+.*\(non-serial, ignored\)/);
    assert.equal(harness.calls().trim(), 'list');
  } finally {
    harness.cleanup();
  }
});

test('attach only targets known-type shared devices and succeeds once nodes appear', async () => {
  const harness = makeHarness();
  try {
    const result = await harness.run(['attach']);
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    const calls = harness.calls();
    assert.match(calls, /attach --wsl --busid=2-5/);
    assert.match(calls, /attach --wsl --busid=2-6/);
    assert.doesNotMatch(calls, /busid=2-4/);
    assert.doesNotMatch(calls, /busid=2-7/);
    assert.doesNotMatch(calls, /busid=3-1/);
    assert.match(result.stdout, /serial nodes are present/);
  } finally {
    harness.cleanup();
  }
});

test('attach honors an explicit busid whitelist', async () => {
  const harness = makeHarness();
  try {
    const result = await harness.run(['attach'], { TTLAB_WSL_SERIAL_BUSIDS: '2-6' });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    const calls = harness.calls();
    assert.match(calls, /attach --wsl --busid=2-6/);
    assert.doesNotMatch(calls, /busid=2-5/);
    assert.doesNotMatch(calls, /busid=2-7/);
  } finally {
    harness.cleanup();
  }
});

test('attach binds then attaches a known-type device that is not yet shared when AUTO_BIND is enabled', async () => {
  const harness = makeHarness();
  try {
    const result = await harness.run(['attach'], { TTLAB_WSL_SERIAL_AUTO_BIND: '1' });
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    const calls = harness.calls();
    assert.match(calls, /bind --busid=2-7/);
    assert.match(calls, /attach --wsl --busid=2-7/);
  } finally {
    harness.cleanup();
  }
});

test('attach reports missing nodes when the device does not appear', async () => {
  const harness = makeHarness();
  try {
    const result = await harness.run(['attach'], {
      TTLAB_WSL_SERIAL_WAIT_SECONDS: '1',
      TTLAB_FAKE_ATTACH_CREATES_NODE: '0',
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr + result.stdout, /no serial nodes appeared/);
  } finally {
    harness.cleanup();
  }
});

test('check exits 0 when a serial node is present and 1 otherwise', async () => {
  const harness = makeHarness();
  try {
    const missing = await harness.run(['check']);
    assert.equal(missing.exitCode, 1);

    writeFileSync(join(harness.devDir, 'ttyUSB0'), '');
    const present = await harness.run(['check']);
    assert.equal(present.exitCode, 0);
    assert.match(present.stdout, /serial nodes are present/);
  } finally {
    harness.cleanup();
  }
});
