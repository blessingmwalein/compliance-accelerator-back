import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LawfulBasisController } from './lawful-basis.controller.js';
import { LawfulBasisRepository } from './lawful-basis.repository.js';
import { LawfulBasisService } from './lawful-basis.service.js';

/** Lawful basis register (Phase 6). */
@Module({
  imports: [AuditModule],
  controllers: [LawfulBasisController],
  providers: [LawfulBasisRepository, LawfulBasisService],
  // The Consolidated DPO Report (Phase 9a) reads the register the way a screen does: through this service.
  exports: [LawfulBasisService],
})
export class LawfulBasisModule {}
