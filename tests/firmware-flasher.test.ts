import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CommandRequest, ManagedDevice, SerialDevice } from '../packages/protocol/src/index.js';
import { UsbDfuFlasher, type FlashContext } from '../apps/client/src/firmware-flasher.js';
import type { SerialAdapter } from '../apps/client/src/serial.js';
import type { DeviceManager } from '../apps/client/src/device-manager.js';

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

const firmwarePayload = Buffer.from('FAKE-GD32-FIRMWARE-PAYLOAD-0123456789');
const firmwareSha256 = sha256Hex(firmwarePayload);

function commandRequest(): CommandRequest {
  return {
    commandId: 'cmd-flash-test',
    deviceId: 'tvbox:test',
    operation: 'firmware.flash',
    parameters: { version: 'V39', artifact: 'Panda_COM-V39-release.bin' },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    firmware: {
      release: 'V39',
      artifact: 'Panda_COM-V39-release.bin',
      downloadUrl: 'http://server/agent/v1/releases/V39/Panda_COM-V39-release.bin?clientId=client-1',
      sha256: firmwareSha256,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
}

const controlPort: SerialDevice = {
  deviceId: 'serial:control',
  path: '/dev/ttyACM0',
  stableIdentity: true,
  status: 'available',
  observedAt: new Date().toISOString(),
};

const device: ManagedDevice = {
  deviceId: 'tvbox:test',
  deviceType: 'tv-stick-test-box',
  displayName: 'TV Stick Test Box',
  stableIdentity: 'tvbox-test',
  status: 'identified',
  ports: [controlPort],
  capabilities: ['firmware-flash'],
  observedAt: new Date().toISOString(),
};

class FakeSerialAdapter implements SerialAdapter {
  readonly calls: Array<{ operation: string; parameters: Record<string, string> }> = [];
  versions: string[] = ['VER:01.00.10', 'VER:01.00.39'];

  async execute(request: CommandRequest) {
    this.calls.push({ operation: request.operation, parameters: request.parameters });
    if (request.operation === 'system.version') {
      const version = this.versions.shift() ?? 'VER:unknown';
      return { commandId: request.commandId, deviceId: request.deviceId, success: true, output: version };
    }
    if (request.operation === 'system.reset') {
      return { commandId: request.commandId, deviceId: request.deviceId, success: true, output: 'OK' };
    }
    return { commandId: request.commandId, deviceId: request.deviceId, success: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'unexpected operation', retryable: false } };
  }
}

class FakeDeviceManager {
  refreshed = 0;
  back = false;
  async refresh(): Promise<boolean> {
    this.refreshed += 1;
    return true;
  }
  resolveCommandTarget() {
    return this.back ? { device, port: controlPort } : undefined;
  }
}

// Mock dfu-util: prints progress on stderr, honors TTLAB_FAKE_DFU_FLASH_EXIT.
function writeMockDfuUtil(dir: string, failFlash = false): string {
  const path = join(dir, 'dfu-util');
  writeFileSync(path, `#!/usr/bin/env bash
set -eu
case "\${1:-}" in
  -l)
    if [ "\${TTLAB_FAKE_DFU_PRESENT:-1}" = "0" ]; then echo "no device"; exit 0; fi
    echo "Found DFU: [28e9:018a] ver=0100, devnum=5, cfg=1, intf=0, path="4-1""
    exit 0
    ;;
  -d)
    shift 2
    if [ "\${1:-}" = "-D" ]; then
      if [ "\${TTLAB_FAKE_DFU_FLASH_EXIT:-0}" != "0" ]; then echo "flash failed" >&2; exit "\${TTLAB_FAKE_DFU_FLASH_EXIT}"; fi
      if [ "\${TTLAB_FAKE_DFU_FLASH_FAIL_ONCE:-0}" = "1" ]; then
        if [ ! -f "\${TTLAB_FAKE_DFU_COUNT:?}" ]; then
          echo "1" > "\${TTLAB_FAKE_DFU_COUNT}"
          echo "flash failed once" >&2
          exit 1
        fi
      fi
      for p in 10 30 60 100; do echo "  [################] \${p}%" >&2; done
      exit 0
    fi
    if [ "\${1:-}" = "-U" ]; then
      if [ "\${TTLAB_FAKE_DFU_VERIFY_EXIT:-0}" != "0" ]; then echo "verify failed" >&2; exit "\${TTLAB_FAKE_DFU_VERIFY_EXIT}"; fi
      cp "\${TTLAB_FAKE_DFU_SRC:-/dev/null}" "\${2:-}" 2>/dev/null || true
      exit 0
    fi
    ;;
esac
exit 1
`);
  chmod(path, 0o755);
  return path;
}

function chmod(path: string, mode: number): void {
  chmodSync(path, mode);
}

function makeFlasher(options: Record<string, unknown> = {}, stateDirectory?: string): UsbDfuFlasher {
  const root = stateDirectory ?? mkdtempSync(join(tmpdir(), 'ttlab-flash-'));
  const flasher = new UsbDfuFlasher({
    stateDirectory: root,
    dfuUtilPath: options.dfuUtilPath as string,
    dfuVid: options.dfuVid as string ?? '28e9',
    dfuPid: options.dfuPid as string ?? '018a',
    fetchImpl: options.fetchImpl as typeof fetch,
    sleep: options.sleep as (ms: number) => Promise<void>,
    downloadTimeoutMs: (options.downloadTimeoutMs as number) ?? 2000,
    dfuWaitTimeoutMs: (options.dfuWaitTimeoutMs as number) ?? 2000,
    flashTimeoutMs: (options.flashTimeoutMs as number) ?? 5000,
    verifyTimeoutMs: (options.verifyTimeoutMs as number) ?? 2000,
    restartTimeoutMs: (options.restartTimeoutMs as number) ?? 2000,
    readbackVerify: (options.readbackVerify as boolean) ?? true,
  });
  return flasher;
}

function makeContext(overrides: Partial<FlashContext> = {}): FlashContext {
  const adapter = new FakeSerialAdapter();
  const deviceManager = new FakeDeviceManager() as unknown as DeviceManager;
  const progress: Array<{ stage: string; progress: number }> = [];
  return {
    request: commandRequest(),
    device,
    port: controlPort,
    adapter,
    deviceManager,
    reportProgress: (stage, p) => progress.push({ stage, progress: p }),
    ...overrides,
  };
}

// The mock dfu-util -U branch copies TTLAB_FAKE_DFU_SRC to the readback path;
// pointing it at the expected firmware payload makes readback verification pass.
function writeFakeDfuSrc(root: string): string {
  const path = join(root, 'expected-firmware.bin');
  writeFileSync(path, firmwarePayload);
  return path;
}

function okFetch(): typeof fetch {
  const response = {
    ok: true,
    body: (async function* () { yield firmwarePayload; })(),
  };
  return (async () => response) as unknown as typeof fetch;
}

function badFetch(): typeof fetch {
  const response = { ok: false, body: null };
  return (async () => response) as unknown as typeof fetch;
}

test('flashes firmware successfully with download, DFU, flash and version verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-flash-'));
  const dfuUtilPath = writeMockDfuUtil(root);
  const dfuSrc = writeFakeDfuSrc(root);
  const adapter = new FakeSerialAdapter();
  const deviceManager = new FakeDeviceManager();
  deviceManager.back = true;
  const flasher = makeFlasher({ dfuUtilPath, fetchImpl: okFetch() }, root);
  process.env.TTLAB_FAKE_DFU_SRC = dfuSrc;
  try {
    const context = makeContext({ adapter, deviceManager: deviceManager as unknown as DeviceManager });
    const result = await flasher.flash(context);
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /flashed V39/);
    assert.match(result.output ?? '', /old version: VER:01.00.10/);
    assert.match(result.output ?? '', /new version: VER:01.00.39/);
    assert.ok(deviceManager.refreshed >= 1);
    const operations = adapter.calls.map((call) => call.operation);
    assert.ok(operations.includes('system.version'));
    assert.ok(operations.includes('system.reset'));
  } finally {
    delete process.env.TTLAB_FAKE_DFU_SRC;
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a command without a firmware reference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-flash-'));
  const flasher = makeFlasher({ fetchImpl: okFetch() }, root);
  const context = makeContext();
  delete context.request.firmware;
  const result = await flasher.flash(context);
  assert.equal(result.success, false);
  assert.equal(result.error?.code, 'INVALID_ARGUMENT');
});

test('fails with FLASH_DOWNLOAD_FAILED when the download does not match the sha256', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-flash-'));
  const dfuUtilPath = writeMockDfuUtil(root);
  const wrongFetch = (async () => ({
    ok: true,
    body: (async function* () { yield Buffer.from('wrong payload'); })(),
  })) as unknown as typeof fetch;
  const flasher = makeFlasher({ dfuUtilPath, fetchImpl: wrongFetch }, root);
  const result = await flasher.flash(makeContext());
  assert.equal(result.success, false);
  assert.equal(result.error?.code, 'FLASH_DOWNLOAD_FAILED');
});

test('fails with FLASH_DFU_WAIT_TIMEOUT when no DFU device appears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-flash-'));
  const dfuUtilPath = writeMockDfuUtil(root);
  const flasher = makeFlasher({ dfuUtilPath, fetchImpl: okFetch(), sleep: async () => undefined, dfuWaitTimeoutMs: 50 }, root);
  const context = makeContext();
  process.env.TTLAB_FAKE_DFU_PRESENT = '0';
  try {
    const result = await flasher.flash(context);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'FLASH_DFU_WAIT_TIMEOUT');
  } finally {
    delete process.env.TTLAB_FAKE_DFU_PRESENT;
    rmSync(root, { recursive: true, force: true });
  }
});

test('retries a failed flash once and reports FLASH_FAILED_DEVICE_IN_DFU when it still fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-flash-'));
  const dfuUtilPath = writeMockDfuUtil(root);
  const flasher = makeFlasher({ dfuUtilPath, fetchImpl: okFetch() }, root);
  const context = makeContext();
  process.env.TTLAB_FAKE_DFU_FLASH_EXIT = '1';
  try {
    const result = await flasher.flash(context);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, 'FLASH_FAILED_DEVICE_IN_DFU');
  } finally {
    delete process.env.TTLAB_FAKE_DFU_FLASH_EXIT;
    rmSync(root, { recursive: true, force: true });
  }
});

test('succeeds after one flash failure when the retry succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ttlab-flash-'));
  const dfuUtilPath = writeMockDfuUtil(root);
  const countPath = join(root, 'flash-count');
  const dfuSrc = writeFakeDfuSrc(root);
  const adapter = new FakeSerialAdapter();
  const deviceManager = new FakeDeviceManager();
  deviceManager.back = true;
  const flasher = makeFlasher({ dfuUtilPath, fetchImpl: okFetch() }, root);
  process.env.TTLAB_FAKE_DFU_FLASH_FAIL_ONCE = '1';
  process.env.TTLAB_FAKE_DFU_COUNT = countPath;
  process.env.TTLAB_FAKE_DFU_SRC = dfuSrc;
  try {
    const context = makeContext({ adapter, deviceManager: deviceManager as unknown as DeviceManager });
    const result = await flasher.flash(context);
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /new version: VER:01.00.39/);
  } finally {
    delete process.env.TTLAB_FAKE_DFU_FLASH_FAIL_ONCE;
    delete process.env.TTLAB_FAKE_DFU_COUNT;
    delete process.env.TTLAB_FAKE_DFU_SRC;
    rmSync(root, { recursive: true, force: true });
  }
});
