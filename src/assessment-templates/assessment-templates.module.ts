import { Module } from '@nestjs/common';
import { AssessmentTemplatesController } from './assessment-templates.controller.js';
import { AssessmentTemplatesRepository } from './assessment-templates.repository.js';
import { AssessmentTemplatesService } from './assessment-templates.service.js';

/**
 * The published quick-start templates (Phase 5, AC-GOV-01): read-only reference data. The assessments module
 * asks this service for a template's subjects when it applies one, never the repository.
 */
@Module({
  controllers: [AssessmentTemplatesController],
  providers: [AssessmentTemplatesRepository, AssessmentTemplatesService],
  exports: [AssessmentTemplatesService],
})
export class AssessmentTemplatesModule {}
