import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DeadlinePolicyModule } from '../deadline-policy/deadline-policy.module.js';
import {
  BreachAssessmentDueAlertHandler,
  BreachNotificationDueAlertHandler,
  BreachRecordedAlertHandler,
} from './breach-alert.handlers.js';
import { BreachesController } from './breaches.controller.js';
import { BreachesRepository } from './breaches.repository.js';
import { BreachesService } from './breaches.service.js';

/**
 * The personal data breach registry (Phase 7). The windows are read through `DeadlinePolicyService`, so a
 * frozen deadline cannot disagree with `GET …/deadline-policy`, and the alert queue through
 * `AlertsService`, so a deadline and the promise to warn about it are written in one transaction. The three
 * alert handlers are providers because the job registry finds handlers by scanning providers at startup.
 */
@Module({
  imports: [AuditModule, AlertsModule, DeadlinePolicyModule],
  controllers: [BreachesController],
  providers: [
    BreachesRepository,
    BreachesService,
    BreachRecordedAlertHandler,
    BreachAssessmentDueAlertHandler,
    BreachNotificationDueAlertHandler,
  ],
})
export class BreachesModule {}
