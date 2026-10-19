import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AssessmentsModule } from '../assessments/assessments.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

/**
 * The report core: a stored record, private storage for the rendered PDF, and one template per document —
 * Governance Assessment (Phase 5) and Executive Dashboard (Phase 8). Data comes from the modules that own it
 * through their services, never from another module's repository, so a document cannot disagree with the
 * screen it was opened from.
 */
@Module({
  imports: [AuditModule, AssessmentsModule, DashboardModule, SettingsModule],
  controllers: [ReportsController],
  providers: [ReportsRepository, ReportsService],
})
export class ReportsModule {}
