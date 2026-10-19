import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AlertDeliveriesRepository } from './alert-deliveries.repository.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';

/**
 * The alert ledger and its queue (Phase 7). `AlertsService` is what a feature module calls in the same
 * transaction that writes its record; the job handlers that run the alerts at send time live in those
 * modules, because only they can read their own table. This module therefore imports nothing that reads
 * incidents, and there is no cycle to break.
 */
@Module({
  imports: [AuthModule, JobsModule, MailModule],
  controllers: [AlertsController],
  providers: [AlertDeliveriesRepository, AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
