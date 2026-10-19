import { Module } from '@nestjs/common';
import { ScoringModule } from '../scoring/scoring.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardRepository } from './dashboard.repository.js';
import { DashboardService } from './dashboard.service.js';

/**
 * The executive dashboard (Phase 8). It reads the scoring service for the bands in force so its exposure
 * figure uses the same bands as the risk register, and it never re-answers a count another module owns.
 */
@Module({
  imports: [ScoringModule],
  controllers: [DashboardController],
  providers: [DashboardRepository, DashboardService],
  // The Executive Dashboard report renders the same payloads the screen reads, through this service.
  exports: [DashboardService],
})
export class DashboardModule {}
