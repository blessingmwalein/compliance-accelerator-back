import { Global, Module } from '@nestjs/common';
import { LocalStorageProvider } from './local-storage.provider.js';
import { StorageProvider } from './storage-provider.js';

/** Global so any feature can inject `StorageProvider`; the driver is chosen here (local today, S3 after gate G0). */
@Global()
@Module({
  providers: [{ provide: StorageProvider, useClass: LocalStorageProvider }],
  exports: [StorageProvider],
})
export class StorageModule {}
