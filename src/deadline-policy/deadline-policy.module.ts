import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DeadlinePolicyController } from './deadline-policy.controller.js';
import { DeadlinePolicyRepository } from './deadline-policy.repository.js';
import { DeadlinePolicyService } from './deadline-policy.service.js';

/**
 * The deadline policy endpoints (Phase 7). The DSAR, breach, reminder and alert modules read the windows
 * through this service, never through the repository, so a frozen deadline can never disagree with
 * `GET …/deadline-policy`.
 */
@Module({
  imports: [AuditModule],
  controllers: [DeadlinePolicyController],
  providers: [DeadlinePolicyRepository, DeadlinePolicyService],
  exports: [DeadlinePolicyService],
})
export class DeadlinePolicyModule {}
