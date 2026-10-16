import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ComplianceMappingsController } from './compliance-mappings.controller.js';
import { OrganisationMappingsRepository } from './compliance-mappings.repository.js';
import { ComplianceMappingsService } from './compliance-mappings.service.js';

/** Compliance mappings and Load Default Mappings (Phase 4). */
@Module({
  imports: [AuditModule],
  controllers: [ComplianceMappingsController],
  providers: [OrganisationMappingsRepository, ComplianceMappingsService],
})
export class ComplianceMappingsModule {}
