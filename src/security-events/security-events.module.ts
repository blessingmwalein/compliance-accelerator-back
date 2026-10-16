import { Module } from '@nestjs/common';
import { SecurityEventsRepository } from './security-events.repository.js';
import { SecurityEventsService } from './security-events.service.js';

@Module({
  providers: [SecurityEventsRepository, SecurityEventsService],
  exports: [SecurityEventsService],
})
export class SecurityEventsModule {}
