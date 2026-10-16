import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobHandlerRegistry } from './job-handler.registry.js';
import { JobRunner } from './job-runner.service.js';
import { JobsPoller } from './jobs.poller.js';
import { JobsRepository } from './jobs.repository.js';
import { JobsService } from './jobs.service.js';
import { JobsTickController } from './jobs-tick.controller.js';

@Module({
  imports: [DiscoveryModule],
  controllers: [JobsTickController],
  providers: [JobsRepository, JobsService, JobHandlerRegistry, JobRunner, JobsPoller],
  exports: [JobsService, JobRunner],
})
export class JobsModule {}
