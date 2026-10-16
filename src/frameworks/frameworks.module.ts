import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import {
  FrameworkReferenceController,
  FrameworkVersionsController,
} from './framework-content.controller.js';
import { FrameworkContentRepository } from './framework-content.repository.js';
import { FrameworkContentService } from './framework-content.service.js';
import { FrameworksController, OrganisationFrameworksController } from './frameworks.controller.js';
import { FrameworksRepository, OrganisationFrameworksRepository } from './frameworks.repository.js';
import { FrameworksService } from './frameworks.service.js';

/**
 * The framework catalogue, each organisation's applicable frameworks (Phase 3) and the loaded, verified
 * framework content with its provenance (Phase 4).
 */
@Module({
  imports: [AuditModule],
  controllers: [
    FrameworksController,
    FrameworkReferenceController,
    FrameworkVersionsController,
    OrganisationFrameworksController,
  ],
  providers: [
    FrameworksRepository,
    OrganisationFrameworksRepository,
    FrameworksService,
    FrameworkContentRepository,
    FrameworkContentService,
  ],
})
export class FrameworksModule {}
