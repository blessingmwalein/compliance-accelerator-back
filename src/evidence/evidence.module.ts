import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceRepository } from './evidence.repository.js';
import { EvidenceService } from './evidence.service.js';

/**
 * The evidence core (Phase 5): private file storage through the global `StorageProvider`, the metadata
 * table, and the authorised upload/download endpoints. Linking evidence to assessment items and
 * remediation tasks is written by those modules, not here.
 */
@Module({
  imports: [AuditModule],
  controllers: [EvidenceController],
  providers: [EvidenceRepository, EvidenceService],
  // Another module that needs to know about an evidence file asks this service (never the repository).
  exports: [EvidenceService],
})
export class EvidenceModule {}
