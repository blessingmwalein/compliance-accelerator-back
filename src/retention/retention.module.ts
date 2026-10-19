import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RetentionController } from './retention.controller.js';
import { RetentionRepository } from './retention.repository.js';
import { RetentionService } from './retention.service.js';

/** Retention rules, legal holds and the disposal log (Phase 6). */
@Module({
  imports: [AuditModule],
  controllers: [RetentionController],
  providers: [RetentionRepository, RetentionService],
})
export class RetentionModule {}
