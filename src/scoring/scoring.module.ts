import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ScoringController } from './scoring.controller.js';
import { ScoringPolicyRepository } from './scoring.repository.js';
import { ScoringService } from './scoring.service.js';

/**
 * The scoring policy endpoints (Phase 5). The assessments and remediation modules read the policy through
 * this service (bands to snapshot, due days and the Plan window), never through the repository.
 */
@Module({
  imports: [AuditModule],
  controllers: [ScoringController],
  providers: [ScoringPolicyRepository, ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}
