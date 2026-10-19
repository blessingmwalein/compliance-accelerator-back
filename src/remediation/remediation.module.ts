import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ScoringModule } from '../scoring/scoring.module.js';
import { RemediationController } from './remediation.controller.js';
import { RemediationRepository } from './remediation.repository.js';
import { RemediationService } from './remediation.service.js';
import { RemediationTimelineRepository } from './remediation-timeline.repository.js';

/**
 * Remediation tasks (Phase 5): the work raised from an assessed gap, its append-only timeline, and the
 * one transactional generation run. No reminders, no emails, no jobs — those are the reminders module.
 * The due days come from the scoring service, so a deadline here is the one the settings screen shows.
 */
@Module({
  imports: [AuditModule, ScoringModule],
  controllers: [RemediationController],
  providers: [RemediationRepository, RemediationTimelineRepository, RemediationService],
})
export class RemediationModule {}
