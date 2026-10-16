import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { STORAGE_KEY_PATTERN, StorageProvider, type StoredFile } from './storage-provider.js';

/** Files under `STORAGE_LOCAL_DIR` (git-ignored). Development and tests only. */
@Injectable()
export class LocalStorageProvider extends StorageProvider {
  private readonly root: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super();
    this.root = resolve(config.get('STORAGE_LOCAL_DIR', { infer: true }));
  }

  async put(key: string, data: Buffer): Promise<StoredFile> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  /** A key that is not a plain path-like string, or that would leave the storage folder, is a programming error. */
  private pathOf(key: string): string {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
    const path = resolve(this.root, ...key.split('/'));
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return path;
  }
}
