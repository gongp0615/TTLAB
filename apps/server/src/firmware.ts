import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { FirmwareManifest } from '../../../packages/protocol/src/index.js';

const safeSegmentPattern = /^[A-Za-z0-9._-]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/i;

export class FirmwareStoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
  }
}

export interface FirmwareStoreOptions {
  directory: string;
  maxBytes?: number;
}

export interface PublishInput {
  version: string;
  artifact: string;
  deviceTypes?: string[];
  description?: string;
  body: AsyncIterable<Buffer | Uint8Array | string>;
}

export class FirmwareStore {
  private readonly firmwareRoot: string;
  private readonly maxBytes: number;

  constructor(options: FirmwareStoreOptions) {
    this.firmwareRoot = join(options.directory, 'firmware');
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
  }

  get root(): string {
    return this.firmwareRoot;
  }

  read(version: string): FirmwareManifest | undefined {
    if (!safeSegmentPattern.test(version)) return undefined;
    const manifestPath = join(this.firmwareRoot, version, 'manifest.json');
    if (!existsSync(manifestPath)) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      return undefined;
    }
    const manifest = value as FirmwareManifest & { deviceType?: string };
    // 兼容旧版 manifest：仅有单值 deviceType 时归一化为 deviceTypes 数组
    const deviceTypes = manifest.deviceTypes ?? (manifest.deviceType !== undefined ? [manifest.deviceType] : undefined);
    if (
      manifest.version !== version
      || !safeSegmentPattern.test(manifest.artifact)
      || !sha256Pattern.test(manifest.sha256)
      || typeof manifest.size !== 'number'
      || !Array.isArray(deviceTypes)
      || deviceTypes.length === 0
      || !deviceTypes.every((item) => typeof item === 'string' && safeSegmentPattern.test(item))
    ) {
      throw new FirmwareStoreError('INVALID_MANIFEST', `invalid firmware manifest for ${version}`);
    }
    return { ...manifest, deviceTypes: [...new Set(deviceTypes)] };
  }

  list(): FirmwareManifest[] {
    if (!existsSync(this.firmwareRoot)) return [];
    return readdirSync(this.firmwareRoot)
      .filter((entry) => safeSegmentPattern.test(entry))
      .map((entry) => {
        try {
          return this.read(entry);
        } catch {
          return undefined;
        }
      })
      .filter((item): item is FirmwareManifest => item !== undefined)
      .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
  }

  artifactPath(version: string, artifact: string): string | undefined {
    if (!safeSegmentPattern.test(version) || !safeSegmentPattern.test(artifact)) return undefined;
    const manifest = this.read(version);
    if (!manifest || manifest.artifact !== artifact) return undefined;
    const path = join(this.firmwareRoot, version, artifact);
    return existsSync(path) ? path : undefined;
  }

  exists(version: string): boolean {
    return this.read(version) !== undefined;
  }

  async publish(input: PublishInput): Promise<FirmwareManifest> {
    const { version, artifact } = input;
    if (!safeSegmentPattern.test(version)) throw new FirmwareStoreError('INVALID_ARGUMENT', 'invalid firmware version', false);
    if (!safeSegmentPattern.test(artifact)) throw new FirmwareStoreError('INVALID_ARGUMENT', 'invalid artifact name', false);
    const deviceTypes = input.deviceTypes && input.deviceTypes.length > 0 ? [...new Set(input.deviceTypes)] : ['tv-stick-test-box'];
    const invalidDeviceType = deviceTypes.find((item) => typeof item !== 'string' || !safeSegmentPattern.test(item));
    if (invalidDeviceType !== undefined) {
      throw new FirmwareStoreError('INVALID_ARGUMENT', `invalid device type "${invalidDeviceType}"`, false);
    }
    if (this.exists(version)) throw new FirmwareStoreError('ALREADY_EXISTS', `firmware release ${version} already exists`, false);
    const targetDirectory = join(this.firmwareRoot, version);
    mkdirSync(targetDirectory, { recursive: true });
    const stagingPath = join(targetDirectory, `.staging-${randomUUID()}`);
    const hash = createHash('sha256');
    let size = 0;
    try {
      const writer = createWriteStream(stagingPath, { flags: 'wx', mode: 0o644 });
      for await (const chunk of input.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > this.maxBytes) {
          writer.destroy();
          throw new FirmwareStoreError('PAYLOAD_TOO_LARGE', `firmware exceeds the ${this.maxBytes} byte limit`, false);
        }
        if (!writer.write(buffer)) await once(writer, 'drain');
        hash.update(buffer);
      }
      writer.end();
      await finished(writer);
      const manifest: FirmwareManifest = {
        version,
        artifact,
        sha256: hash.digest('hex'),
        size,
        deviceTypes,
        releasedAt: new Date().toISOString(),
        ...(input.description !== undefined ? { description: input.description } : {}),
      };
      renameSync(stagingPath, join(targetDirectory, artifact));
      const manifestStaging = join(targetDirectory, '.manifest-staging');
      writeFileSync(manifestStaging, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
      renameSync(manifestStaging, join(targetDirectory, 'manifest.json'));
      return manifest;
    } catch (error) {
      rmSync(stagingPath, { force: true });
      rmSync(join(targetDirectory, '.manifest-staging'), { force: true });
      if (error instanceof FirmwareStoreError) throw error;
      throw new FirmwareStoreError('STORE_FAILED', error instanceof Error ? error.message : 'firmware publish failed', true);
    }
  }
}
