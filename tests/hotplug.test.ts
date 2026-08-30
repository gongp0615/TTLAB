import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceManager } from '../apps/client/src/device-manager.js';
import type { SerialPortInfo } from '../apps/client/src/discovery.js';

// 与真实 device-bindings.json 一致的 GD32 设备
const gd32 = (path: string): SerialPortInfo => ({
  deviceId: 'serial:usb-GigaDevice_GD32-CDC_ACM_798690630E46-if00',
  path,
  stableIdentity: true,
  hardwareKey: '28e9:018a:798690630E46',
  vendorId: '28e9',
  productId: '018a',
  serialNumber: '798690630E46',
  deviceType: 'generic-serial',
  status: 'available',
  observedAt: new Date().toISOString(),
});

// 重插后 udevadm 数据库暂时缺失，属性只能靠 sysfs 兜底（测试环境读不到 -> 缺失）。
// exactOptionalPropertyTypes 不允许显式 undefined，这里移除硬件属性字段。
const gd32NoUdevProps = (path: string): SerialPortInfo => {
  const { vendorId, productId, serialNumber, ...rest } = gd32(path);
  void vendorId; void productId; void serialNumber;
  return { ...rest, hardwareKey: 'usb-GigaDevice_GD32-CDC_ACM_798690630E46-if00' };
};

// 重插后 udev 厂商库缺失，by-id entry 名退化为十六进制形式（硬件属性仍可读）
const gd32HexEntry = (path: string): SerialPortInfo => ({
  ...gd32(path),
  deviceId: 'serial:usb-28e9_018a_798690630E46-if00',
});

function makeManager(ports: () => SerialPortInfo[], probeResult: () => boolean): { manager: DeviceManager; stateDir: string; cleanup: () => void } {
  const stateDir = mkdtempSync(join(tmpdir(), 'ttlab-hotplug-'));
  const manager = new DeviceManager({
    stateDirectory: stateDir,
    discoverPorts: ports,
    probeEnabled: true,
    probePort: async () => probeResult(),
    debugDevices: true,
  });
  return { manager, stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test('replug with identical identity recovers identified', async () => {
  let present = true;
  const { manager, cleanup } = makeManager(() => (present ? [gd32('/dev/ttyACM0')] : []), () => true);
  try {
    assert.equal(await manager.refresh(), true);
    const firstDeviceId = manager.managedDevices[0]?.deviceId;
    assert.equal(manager.managedDevices[0]?.status, 'identified');
    present = false;
    assert.equal(await manager.refresh(), true);
    assert.equal(manager.managedDevices.length, 0);
    present = true;
    assert.equal(await manager.refresh(), true, 'replug must trigger refresh');
    assert.equal(manager.managedDevices[0]?.status, 'identified');
    assert.equal(manager.managedDevices[0]?.deviceId, firstDeviceId, 'deviceId must stay stable across replug');
  } finally {
    cleanup();
  }
});

test('replug with missing udev properties recovers via re-probe', async () => {
  let mode: 'normal' | 'noprops' = 'normal';
  const { manager, cleanup } = makeManager(() => (mode === 'normal' ? [gd32('/dev/ttyACM0')] : [gd32NoUdevProps('/dev/ttyACM0')]), () => true);
  try {
    assert.equal(await manager.refresh(), true);
    assert.equal(manager.managedDevices[0]?.status, 'identified');
    assert.equal(manager.managedDevices[0]?.deviceType, 'tv-stick-test-box');
    mode = 'noprops';
    assert.equal(await manager.refresh(), true);
    assert.equal(manager.managedDevices.length, 1, 'device must not be lost when udev properties are missing');
    assert.equal(manager.managedDevices[0]?.status, 'identified', 'stale binding must be healed by re-probing');
  } finally {
    cleanup();
  }
});

test('replug with hex by-id entry keeps device type and identity', async () => {
  let mode: 'normal' | 'hex' = 'normal';
  const { manager, cleanup } = makeManager(() => (mode === 'normal' ? [gd32('/dev/ttyACM0')] : [gd32HexEntry('/dev/ttyACM0')]), () => true);
  try {
    assert.equal(await manager.refresh(), true);
    const firstDeviceId = manager.managedDevices[0]?.deviceId;
    assert.equal(manager.managedDevices[0]?.status, 'identified');
    mode = 'hex';
    assert.equal(await manager.refresh(), true);
    assert.equal(manager.managedDevices[0]?.deviceType, 'tv-stick-test-box', 'device type must survive by-id name drift');
    assert.equal(manager.managedDevices[0]?.deviceId, firstDeviceId, 'deviceId must stay stable across replug');
    assert.equal(manager.managedDevices[0]?.status, 'identified');
  } finally {
    cleanup();
  }
});

test('stable hardware binding heals replug even when probe fails', async () => {
  let mode: 'normal' | 'hex' = 'normal';
  let probeOk = true;
  const { manager, cleanup } = makeManager(() => (mode === 'normal' ? [gd32('/dev/ttyACM0')] : [gd32HexEntry('/dev/ttyACM0')]), () => probeOk);
  try {
    assert.equal(await manager.refresh(), true);
    assert.equal(manager.managedDevices[0]?.status, 'identified');
    // 重插后 by-id 名称漂移且 probe 失败：hardwareKey 绑定仍可直接恢复 identified
    mode = 'hex';
    probeOk = false;
    assert.equal(await manager.refresh(), true);
    assert.equal(manager.managedDevices.length, 1, 'device must be discovered after replug');
    assert.equal(manager.managedDevices[0]?.status, 'identified', 'hardwareKey binding must recover without probe');
  } finally {
    cleanup();
  }
});

test('stale binding plus probe failure leaves device discovered but not identified', async () => {
  let mode: 'normal' | 'noprops' = 'normal';
  let probeOk = true;
  const { manager, cleanup } = makeManager(() => (mode === 'normal' ? [gd32('/dev/ttyACM0')] : [gd32NoUdevProps('/dev/ttyACM0')]), () => probeOk);
  try {
    assert.equal(await manager.refresh(), true);
    assert.equal(manager.managedDevices[0]?.status, 'identified');
    // 重插后硬件属性缺失（hardwareKey 退化）且 probe 失败：设备必须仍被发现，但无法 identified
    mode = 'noprops';
    probeOk = false;
    assert.equal(await manager.refresh(), true);
    assert.equal(manager.managedDevices.length, 1, 'device must be discovered after replug even if probe fails');
    assert.notEqual(manager.managedDevices[0]?.status, 'identified');
  } finally {
    cleanup();
  }
});

test('scan failure is caught and keeps previous state', async () => {
  let fail = false;
  const { manager, cleanup } = makeManager(() => {
    if (fail) throw new Error('boom');
    return [gd32('/dev/ttyACM0')];
  }, () => true);
  try {
    assert.equal(await manager.refresh(), true);
    fail = true;
    // 不应抛出未处理异常，且保持上次设备状态
    assert.equal(await manager.refresh(), false);
    assert.equal(manager.managedDevices.length, 1);
  } finally {
    cleanup();
  }
});
