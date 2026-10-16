import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BusinessUnitsController } from './business-units.controller.js';
import { BusinessUnitsRepository } from './business-units.repository.js';
import { BusinessUnitsService } from './business-units.service.js';

/** Business Units (Phase 3). */
@Module({
  imports: [AuditModule],
  controllers: [BusinessUnitsController],
  providers: [BusinessUnitsRepository, BusinessUnitsService],
})
export class BusinessUnitsModule {}
