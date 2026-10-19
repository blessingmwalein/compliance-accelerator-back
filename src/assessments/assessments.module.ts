import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AssessmentTemplatesModule } from '../assessment-templates/assessment-templates.module.js';
import { ScoringModule } from '../scoring/scoring.module.js';
import { AssessmentItemsController } from './assessment-items.controller.js';
import { AssessmentItemsRepository } from './assessment-items.repository.js';
import { AssessmentItemsService } from './assessment-items.service.js';
import { AssessmentsController } from './assessments.controller.js';
import { AssessmentsRepository } from './assessments.repository.js';
import { AssessmentsService } from './assessments.service.js';

/**
 * Assessment cycles and their items (Phase 5). The band snapshot a cycle scores against comes from ScoringModule
 * and the quick-start subjects from AssessmentTemplatesModule; both are read through their services.
 */
@Module({
  imports: [AuditModule, ScoringModule, AssessmentTemplatesModule],
  controllers: [AssessmentsController, AssessmentItemsController],
  providers: [
    AssessmentsRepository,
    AssessmentItemsRepository,
    AssessmentsService,
    AssessmentItemsService,
  ],
  // Reports render through these services: another module never reaches into a repository.
  exports: [AssessmentsService, AssessmentItemsService],
})
export class AssessmentsModule {}
