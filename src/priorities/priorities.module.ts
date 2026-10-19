import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ScoringModule } from '../scoring/scoring.module.js';
import { PrioritiesController } from './priorities.controller.js';
import { PrioritiesRepository } from './priorities.repository.js';
import { PrioritiesService } from './priorities.service.js';

/**
 * The Eisenhower priority matrix (Phase 5): the questionnaire answers of an assessment item, the flags and
 * quadrant the ruleset derives from them, and the authorised adjustment of a flag. The quadrant itself is
 * never stored, so it can never go stale against its criteria. The Plan window comes from the scoring
 * service, so the matrix and `GET …/scoring` always read one policy.
 */
@Module({
  imports: [AuditModule, ScoringModule],
  controllers: [PrioritiesController],
  providers: [PrioritiesRepository, PrioritiesService],
})
export class PrioritiesModule {}
