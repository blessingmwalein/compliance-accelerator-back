import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';
import { AuditTrailService } from './audit-trail.service.js';

@Module({
  controllers: [AuditController],
  providers: [AuditRepository, AuditService, AuditTrailService],
  exports: [AuditService],
})
export class AuditModule {}
