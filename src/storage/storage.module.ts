import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageDriver, type EnvironmentVariables } from '../config/env.schema.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import { S3StorageProvider } from './s3-storage.provider.js';
import { StorageProvider } from './storage-provider.js';

/**
 * Global so any feature can inject `StorageProvider`. The driver is chosen here from `STORAGE_DRIVER`: local on
 * a developer's machine, S3-compatible wherever the host may discard the disk (ADR-0007). Nothing below this
 * module knows which one it got.
 */
@Global()
@Module({
  providers: [
    {
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): StorageProvider =>
        config.get('STORAGE_DRIVER', { infer: true }) === StorageDriver.S3
          ? new S3StorageProvider(config)
          : new LocalStorageProvider(config),
    },
  ],
  exports: [StorageProvider],
})
export class StorageModule {}
