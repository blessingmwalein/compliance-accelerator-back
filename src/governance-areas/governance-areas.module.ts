import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { GovernanceAreasController } from './governance-areas.controller.js';
import { GovernanceAreasRepository } from './governance-areas.repository.js';
import { GovernanceAreasService } from './governance-areas.service.js';

/** Governance areas, the topics that compliance mappings are filed under (Phase 4). */
@Module({
  imports: [AuditModule],
  controllers: [GovernanceAreasController],
  providers: [GovernanceAreasRepository, GovernanceAreasService],
})
export class GovernanceAreasModule {}
