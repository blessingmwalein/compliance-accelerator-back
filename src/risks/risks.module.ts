import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RisksController } from './risks.controller.js';
import { RisksRepository } from './risks.repository.js';
import { RisksService } from './risks.service.js';

/** The risk register and its acceptance ledger (Phase 6). */
@Module({
  imports: [AuditModule],
  controllers: [RisksController],
  providers: [RisksRepository, RisksService],
  // The Consolidated DPO Report (Phase 9a) reads the register the way a screen does: through this service.
  exports: [RisksService],
})
export class RisksModule {}
