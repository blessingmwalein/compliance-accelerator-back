import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RegulatorContactsController } from './regulator-contacts.controller.js';
import { RegulatorContactsRepository } from './regulator-contacts.repository.js';
import { RegulatorContactsService } from './regulator-contacts.service.js';
import { SettingsController } from './settings.controller.js';
import { SettingsRepository } from './settings.repository.js';
import { SettingsService } from './settings.service.js';

/** Company Settings: company information, DPO contact, logo and regulator contacts (Phase 3). */
@Module({
  imports: [AuditModule],
  controllers: [SettingsController, RegulatorContactsController],
  providers: [
    SettingsRepository,
    SettingsService,
    RegulatorContactsRepository,
    RegulatorContactsService,
  ],
  // Reports need the organisation's name and timezone through this service, never through the repository.
  exports: [SettingsService],
})
export class SettingsModule {}
