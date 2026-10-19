import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DeadlinePolicyModule } from '../deadline-policy/deadline-policy.module.js';
import { DsarDueSoonAlertHandler, DsarOverdueAlertHandler } from './dsar-alert.handlers.js';
import { DsarController } from './dsar.controller.js';
import { DsarRepository } from './dsar.repository.js';
import { DsarService } from './dsar.service.js';

/**
 * The data subject request tracker (Phase 7). The response window is read through `DeadlinePolicyService`
 * and frozen onto the request, and the alert queue through `AlertsService`, so a deadline and the promise to
 * warn about it land in one transaction. The two alert handlers are providers because the job registry finds
 * handlers by scanning providers at startup.
 */
@Module({
  imports: [AuditModule, AlertsModule, DeadlinePolicyModule],
  controllers: [DsarController],
  providers: [DsarRepository, DsarService, DsarDueSoonAlertHandler, DsarOverdueAlertHandler],
})
export class DsarModule {}
