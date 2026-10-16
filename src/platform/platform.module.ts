import { Module } from '@nestjs/common';
import { OrganisationsModule } from '../organisations/organisations.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { PlatformPlansController } from './platform-plans.controller.js';
import { PlatformOrganisationsRepository } from './platform-organisations.repository.js';
import { PlatformController } from './platform.controller.js';
import { PlatformService } from './platform.service.js';

@Module({
  imports: [OrganisationsModule, PlansModule],
  controllers: [PlatformController, PlatformPlansController],
  providers: [PlatformOrganisationsRepository, PlatformService],
})
export class PlatformModule {}
