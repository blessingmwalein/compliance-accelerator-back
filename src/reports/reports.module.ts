import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AssessmentsModule } from '../assessments/assessments.module.js';
import { BreachesModule } from '../breaches/breaches.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { DsarModule } from '../dsar/dsar.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { LawfulBasisModule } from '../lawful-basis/lawful-basis.module.js';
import { RetentionModule } from '../retention/retention.module.js';
import { RisksModule } from '../risks/risks.module.js';
import { RopaModule } from '../ropa/ropa.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ConsolidatedDpoService } from './consolidated-dpo.service.js';
import { ReportGenerateHandler } from './report-generate.handler.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

/**
 * The report module: a stored record, private storage for the rendered PDF, the catalogue and history, and one
 * definition per document — Governance Assessment (Phase 5), Executive Dashboard (Phase 8) and the Consolidated
 * DPO Report (Phase 9a). Data comes from the modules that own it through their services, never from another
 * module's repository, so a document cannot disagree with the screen it was opened from.
 *
 * The DPO report is the one template a job renders, which is why the module owns a handler of the outbox and
 * imports the six registers it draws.
 */
@Module({
  imports: [
    AssessmentsModule,
    AuditModule,
    BreachesModule,
    DashboardModule,
    DsarModule,
    JobsModule,
    LawfulBasisModule,
    RetentionModule,
    RisksModule,
    RopaModule,
    SettingsModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsRepository, ReportsService, ConsolidatedDpoService, ReportGenerateHandler],
})
export class ReportsModule {}
