import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RopaController } from './ropa.controller.js';
import { RopaRepository } from './ropa.repository.js';
import { RopaService } from './ropa.service.js';

/** Record of Processing Activities (Phase 6). */
@Module({
  imports: [AuditModule],
  controllers: [RopaController],
  providers: [RopaRepository, RopaService],
})
export class RopaModule {}
