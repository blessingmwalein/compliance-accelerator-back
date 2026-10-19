import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DeadlinePolicyModule } from '../deadline-policy/deadline-policy.module.js';
import {
  ReminderDueSoonAlertHandler,
  ReminderOverdueAlertHandler,
} from './reminder-alert.handlers.js';
import { RemindersController } from './reminders.controller.js';
import { RemindersRepository } from './reminders.repository.js';
import { RemindersService } from './reminders.service.js';

/**
 * The reminder ledger and its preferences (Phase 7). The policy is read through `DeadlinePolicyService` and
 * the alerts through `AlertsService`, so a lead window and a queued alert cannot disagree with the routes
 * that show them; the two job handlers live here because only this module can read `reminders`.
 */
@Module({
  imports: [AuditModule, AlertsModule, DeadlinePolicyModule],
  controllers: [RemindersController],
  providers: [
    RemindersRepository,
    RemindersService,
    ReminderDueSoonAlertHandler,
    ReminderOverdueAlertHandler,
  ],
})
export class RemindersModule {}
