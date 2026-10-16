import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller.js';
import { PlansRepository } from './plans.repository.js';
import { PlansService } from './plans.service.js';

/** The plan catalogue (Phase 3). What an organisation is entitled to lives in the organisations module. */
@Module({
  controllers: [PlansController],
  providers: [PlansRepository, PlansService],
  exports: [PlansService],
})
export class PlansModule {}
