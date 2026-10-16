import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Global so repositories in any feature module can inject PrismaService. Only `*.repository.ts`
 * files (and health probes) may do so; see the backend-architecture skill.
 */
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
