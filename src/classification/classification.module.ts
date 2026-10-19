import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ClassificationController } from './classification.controller.js';
import { ClassificationRepository } from './classification.repository.js';
import { ClassificationService } from './classification.service.js';

/** Data classification scheme (Phase 6). */
@Module({
  imports: [AuditModule],
  controllers: [ClassificationController],
  providers: [ClassificationRepository, ClassificationService],
})
export class ClassificationModule {}
