import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { DeviceLogChunk, ManagedDevice, SerialDevice } from '../../../packages/protocol/src/index.js';
import { discoverSerialPorts, buildManagedDevices, isTvStickTestBoxPort, isTvStickTestBoxProbePort, tvBoxProfile, type DeviceTypeProfile, type SerialPortInfo } from './discovery.js';
import { probeTvStickPort, SerialLogCollector } from './serial.js';

interface DeviceBinding {
  controlSelector?: string | undefined;
  logSelector?: string | undefined;
}

export interface DeviceManagerOptions {
  stateDirectory: string;
  controlSelector?: string | undefined;
  logSelector?: string | undefined;
  probeEnabled?: boolean | undefined;
  probePort?: ((path: string, timeoutMs: number) => Promise<boolean>) | undefined;
  discoverPorts?: (() => SerialPortInfo[]) | undefined;
  onLog?: ((chunk: DeviceLogChunk) => void) | undefined;
  onLogError?: ((port: SerialDevice, error: Error) => void) | undefined;
  debugDevices?: boolean | undefined;
  tvBoxProfile?: DeviceTypeProfile | undefined;
}

export interface CommandTarget {
  device: ManagedDevice;
  port: SerialDevice;
}

export class DeviceManager {
  private readonly options: DeviceManagerOptions;
  private readonly bindingsPath: string;
  private readonly collectors = new Map<string, SerialLogCollector>();
  private readonly sequences = new Map<string, number>();
  private ports: SerialPortInfo[] = [];
  private devices: ManagedDevice[] = [];
  private signature = '';

  constructor(options: DeviceManagerOptions) {
    this.options = options;
    this.bindingsPath = `${options.stateDirectory}/device-bindings.json`;
  }

  get serialPorts(): SerialDevice[] {
    return this.ports;
  }

  get managedDevices(): ManagedDevice[] {
    return this.devices;
  }

  async refresh(): Promise<boolean> {
    const ports = (this.options.discoverPorts ?? discoverSerialPorts)();
    const hardwareSignature = ports.map((port) => `${port.deviceId}:${port.path}:${port.hardwareKey ?? ''}`).sort().join('|');
    if (hardwareSignature === this.signature) return false;
    const binding = this.readBinding();
    let controlSelector = this.options.controlSelector ?? binding.controlSelector;
    let logSelector = this.options.logSelector ?? binding.logSelector;
    const tvPorts = ports.filter(isTvStickTestBoxPort);
    const profile = this.options.tvBoxProfile ?? tvBoxProfile;
    if (tvPorts.length > 0 && !controlSelector && this.options.probeEnabled !== false) {
      for (const port of tvPorts.filter(isTvStickTestBoxProbePort)) {
        try {
          const probe = this.options.probePort ?? ((path: string, timeoutMs: number) => probeTvStickPort(path, timeoutMs, undefined, profile?.probe.command, profile?.probe.responsePrefix));
          if (await probe(port.path, profile?.probe.timeoutMs ?? 3000)) {
            controlSelector = port.deviceId;
            break;
          }
        } catch {
          // A non-control UART is expected to fail the safe AT probe.
        }
      }
    }
    const previousDevices = this.devices;
    this.ports = ports;
    this.devices = buildManagedDevices(ports, { controlSelector, logSelector });
    this.signature = hardwareSignature;
    if (controlSelector || logSelector) this.writeBinding({ controlSelector, logSelector });
    await this.reconcileLogCollectors();
    if (this.options.debugDevices === true) {
      const statusOf = (devices: ManagedDevice[]) => devices.map((device) => `${device.deviceId}:${device.status}:${device.ports.map((port) => port.portRole ?? '?').join('/')}`).join('; ') || '(none)';
      console.log(JSON.stringify({ event: 'device_manager_refresh', signatureChanged: true, ports: ports.length, tvPorts: tvPorts.length, before: statusOf(previousDevices), after: statusOf(this.devices), controlSelector, logSelector, at: new Date().toISOString() }));
    }
    return true;
  }

  resolveCommandTarget(deviceId: string): CommandTarget | undefined {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device) return undefined;
    const port = device.ports.find((candidate) => candidate.portRole === 'control');
    return port ? { device, port } : undefined;
  }

  private readBinding(): DeviceBinding {
    if (!existsSync(this.bindingsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.bindingsPath, 'utf8')) as DeviceBinding;
    } catch {
      return {};
    }
  }

  private writeBinding(binding: DeviceBinding): void {
    mkdirSync(this.options.stateDirectory, { recursive: true, mode: 0o750 });
    writeFileSync(this.bindingsPath, JSON.stringify(binding) + '\n', { mode: 0o640 });
  }

  private async reconcileLogCollectors(): Promise<void> {
    const logPorts = this.devices.flatMap((device) => device.ports.filter((port) => device.deviceType === 'tv-stick-test-box' && (port.portRole === 'log' || port.portRole === 'log-candidate')).map((port) => ({ device, port })));
    const desired = new Set(logPorts.map(({ port }) => port.deviceId));
    for (const [portId, collector] of this.collectors) {
      if (!desired.has(portId)) {
        await collector.close();
        this.collectors.delete(portId);
      }
    }
    for (const { device, port } of logPorts) {
      if (this.collectors.has(port.deviceId)) continue;
      try {
        const collector = await SerialLogCollector.open(port.path, (data) => this.emitLog(device, port, data), (error) => this.options.onLogError?.(port, error), (this.options.tvBoxProfile ?? tvBoxProfile)?.baudRate);
        this.collectors.set(port.deviceId, collector);
      } catch (error) {
        this.options.onLogError?.(port, error instanceof Error ? error : new Error('unable to open serial log port'));
      }
    }
  }

  private emitLog(device: ManagedDevice, port: SerialDevice, data: string): void {
    const previous = this.sequences.get(port.deviceId) ?? 0;
    const sequence = previous + 1;
    this.sequences.set(port.deviceId, sequence);
    const maxLength = 16 * 1024;
    this.options.onLog?.({ deviceId: device.deviceId, portId: port.deviceId, sequence, capturedAt: new Date().toISOString(), data: data.slice(0, maxLength), encoding: 'utf-8', truncated: data.length > maxLength });
  }

  async close(): Promise<void> {
    await Promise.all([...this.collectors.values()].map((collector) => collector.close()));
    this.collectors.clear();
  }
}
