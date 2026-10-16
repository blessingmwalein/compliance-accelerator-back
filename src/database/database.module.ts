import { Global, Module } from '@nestjs/common';
import { UnitOfWork } from './unit-of-work.js';

/** Global so any feature service can inject `UnitOfWork`. Needs PrismaModule and TenancyModule (both global). */
@Global()
@Module({ providers: [UnitOfWork], exports: [UnitOfWork] })
export class DatabaseModule {}
