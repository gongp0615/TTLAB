import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import type { DeviceOperation, ManagedDevice, SerialDevice } from '../../../packages/protocol/src/index.js';

export interface SerialPortInfo extends SerialDevice {
  interfaceNumber?: string;
  usbPath?: string;
}

interface DeviceTypeMatch {
  vendorId?: string;
  productId?: string;
  namePattern?: string;
}

interface DeviceTypeProfile {
  type: string;
  displayName: string;
  match: DeviceTypeMatch[];
  probeMatch?: DeviceTypeMatch[];
  probe: { command: string; responsePrefix: string; timeoutMs: number };
  baudRate: string;
  capabilities: string[];
  operations?: DeviceOperation[];
}

function readTvBoxProfile(): DeviceTypeProfile | undefined {
  const file = process.env.TTLAB_TVBOX_PROFILE ?? './device-types/tv-stick-test-box/device.json';
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DeviceTypeProfile;
  } catch {
    return undefined;
  }
}

export const tvBoxProfile = readTvBoxProfile();

function udevProperties(path: string): Record<string, string> {
  try {
    const output = execFileSync('udevadm', ['info', '--query=property', '--name', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Object.fromEntries(output.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf('=');
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
    }));
  } catch {
    return {};
  }
}

function portFromEntry(entry: string, path: string, stableIdentity: boolean, observedAt: string): SerialPortInfo {
  const properties = udevProperties(path);
  const vendorId = properties.ID_VENDOR_ID;
  const productId = properties.ID_MODEL_ID;
  const serialNumber = properties.ID_SERIAL_SHORT ?? properties.ID_SERIAL;
  const hardwareKey = [vendorId, productId, serialNumber].filter(Boolean).join(':') || entry;
  return {
    deviceId: stableIdentity ? `serial:${entry}` : `path:${path}`,
    path,
    stableIdentity,
    status: 'available',
    observedAt,
    ...(vendorId ? { vendorId } : {}),
    ...(productId ? { productId } : {}),
    ...(serialNumber ? { serialNumber } : {}),
    ...(properties.ID_USB_INTERFACE_NUM ? { interfaceNumber: properties.ID_USB_INTERFACE_NUM } : {}),
    ...(properties.ID_PATH ? { usbPath: properties.ID_PATH } : {}),
    hardwareKey,
    deviceType: 'generic-serial',
  };
}

export function discoverSerialPorts(): SerialPortInfo[] {
  const observedAt = new Date().toISOString();
  const byIdDirectory = '/dev/serial/by-id';
  if (existsSync(byIdDirectory)) {
    return readdirSync(byIdDirectory).sort().flatMap((entry) => {
      try {
        return [portFromEntry(entry, realpathSync(`${byIdDirectory}/${entry}`), true, observedAt)];
      } catch {
        return [];
      }
    });
  }
  if (!existsSync('/dev')) return [];
  return readdirSync('/dev').filter((entry) => /^(ttyUSB|ttyACM)\d+$/.test(entry)).sort().map((entry) => portFromEntry(entry, `/dev/${entry}`, false, observedAt));
}

export function isTvStickTestBoxPort(port: SerialPortInfo): boolean {
  return matchesProfileRules(port, tvBoxProfile?.match ?? []);
}

export function isTvStickTestBoxProbePort(port: SerialPortInfo): boolean {
  return matchesProfileRules(port, tvBoxProfile?.probeMatch ?? []);
}

function matchesProfileRules(port: SerialPortInfo, rules: DeviceTypeMatch[]): boolean {
  return rules.some((rule) => {
    const vendorMatches = !rule.vendorId || rule.vendorId.toLowerCase() === port.vendorId?.toLowerCase();
    const productMatches = !rule.productId || rule.productId.toLowerCase() === port.productId?.toLowerCase();
    const nameMatches = !rule.namePattern || new RegExp(rule.namePattern, 'i').test(port.deviceId);
    const hasHardwareProperties = Boolean(port.vendorId || port.productId);
    return nameMatches && (!hasHardwareProperties || (vendorMatches && productMatches));
  });
}

function selectorMatches(port: SerialPortInfo, selector: string | undefined): boolean {
  if (!selector) return false;
  return [port.deviceId, port.path, port.hardwareKey, port.serialNumber].filter(Boolean).some((value) => value === selector);
}

function groupId(ports: SerialPortInfo[]): { deviceId: string; stableIdentity: string } {
  const identity = [...new Set(ports.map((port) => port.hardwareKey ?? port.deviceId))].sort().join('|');
  return { deviceId: `tvbox:${identity}`, stableIdentity: identity };
}

export interface BuildManagedDeviceOptions {
  controlSelector?: string | undefined;
  logSelector?: string | undefined;
  controlPort?: string | undefined;
  logPort?: string | undefined;
}

export function buildManagedDevices(ports: SerialPortInfo[], options: BuildManagedDeviceOptions = {}): ManagedDevice[] {
  const tvPorts = ports.filter(isTvStickTestBoxPort);
  const devices: ManagedDevice[] = [];
  if (tvPorts.length > 0) {
    const identity = groupId(tvPorts);
    const selectedControl = tvPorts.find((port) => selectorMatches(port, options.controlSelector) || selectorMatches(port, options.controlPort));
    const selectedLog = tvPorts.find((port) => port.deviceId !== selectedControl?.deviceId && (selectorMatches(port, options.logSelector) || selectorMatches(port, options.logPort)));
    const boundPorts = tvPorts.map((port) => ({
      ...port,
      parentDeviceId: identity.deviceId,
      portRole: selectedControl?.deviceId === port.deviceId ? 'control' as const : selectedLog?.deviceId === port.deviceId ? 'log' as const : options.logSelector || options.logPort ? 'dut-debug' as const : 'log-candidate' as const,
      deviceType: 'tv-stick-test-box',
    }));
    const hasControl = boundPorts.some((port) => port.portRole === 'control');
    devices.push({ deviceId: identity.deviceId, deviceType: tvBoxProfile?.type ?? 'tv-stick-test-box', displayName: tvBoxProfile?.displayName ?? 'TV Stick Test Box', stableIdentity: identity.stableIdentity, status: hasControl ? 'identified' : selectedControl || selectedLog ? 'matched' : 'ambiguous', ports: boundPorts, capabilities: tvBoxProfile?.capabilities ?? ['serial-control', 'serial-log'], operations: tvBoxProfile?.operations ?? [], observedAt: new Date().toISOString(), identification: hasControl ? { method: selectedControl ? 'binding' : 'probe', confidence: 'high' } : { method: 'hardware', confidence: 'medium', message: 'control and log ports require binding or safe probe' } });
  }
  for (const port of ports.filter((candidate) => !tvPorts.includes(candidate))) {
    devices.push({ deviceId: port.deviceId, deviceType: 'generic-serial', displayName: port.deviceId, stableIdentity: port.hardwareKey ?? port.deviceId, status: 'matched', ports: [port], capabilities: ['serial'], observedAt: port.observedAt, identification: { method: 'hardware', confidence: 'low' } });
  }
  return devices;
}
