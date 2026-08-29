import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManagedDevices, type SerialPortInfo } from '../apps/client/src/discovery.js';

const ports: SerialPortInfo[] = [
  { deviceId: 'serial:usb-GigaDevice_GD32-CDC_ACM_798690630E46-if00', path: '/dev/ttyACM0', stableIdentity: true, hardwareKey: '28e9:018a:798690630E46', deviceType: 'generic-serial', status: 'available', observedAt: new Date().toISOString() },
  { deviceId: 'serial:usb-Silicon_Labs_CP2105_Dual_USB_to_UART_Bridge_Controller_01F02F60-if00-port0', path: '/dev/ttyUSB0', stableIdentity: true, hardwareKey: '10c4:ea70:01F02F60', deviceType: 'generic-serial', status: 'available', observedAt: new Date().toISOString() },
  { deviceId: 'serial:usb-Silicon_Labs_CP2105_Dual_USB_to_UART_Bridge_Controller_01F02F60-if01-port0', path: '/dev/ttyUSB1', stableIdentity: true, hardwareKey: '10c4:ea70:01F02F60', deviceType: 'generic-serial', status: 'available', observedAt: new Date().toISOString() },
];

test('groups the Test Box hardware endpoints into one classified device', () => {
  const [device] = buildManagedDevices(ports, { controlSelector: '/dev/ttyACM0', logSelector: '/dev/ttyUSB0' });
  assert.equal(device?.deviceType, 'tv-stick-test-box');
  assert.equal(device?.status, 'identified');
  assert.equal(device?.ports.length, 3);
  assert.equal(device?.ports.find((port) => port.path === '/dev/ttyACM0')?.portRole, 'control');
  assert.equal(device?.ports.find((port) => port.path === '/dev/ttyUSB0')?.portRole, 'log');
  assert.equal(device?.ports.find((port) => port.path === '/dev/ttyUSB1')?.portRole, 'dut-debug');
});

test('keeps a matching Test Box ambiguous until its control port is confirmed', () => {
  const [device] = buildManagedDevices(ports);
  assert.equal(device?.deviceType, 'tv-stick-test-box');
  assert.equal(device?.status, 'ambiguous');
  assert.equal(device?.ports.every((port) => port.portRole === 'log-candidate'), true);
});
