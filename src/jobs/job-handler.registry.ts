import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { JOB_HANDLER_METADATA, type JobHandlerContract } from './job-handler.js';

/** Finds every provider decorated with `@JobHandler(type)` once at startup. Two handlers for one type fail the boot. */
@Injectable()
export class JobHandlerRegistry implements OnModuleInit {
  private readonly handlers = new Map<string, JobHandlerContract>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!instance || typeof metatype !== 'function') continue;
      const type = this.reflector.get<string | undefined>(JOB_HANDLER_METADATA, metatype);
      if (type === undefined) continue;
      if (this.handlers.has(type)) throw new Error(`Two job handlers are registered for "${type}"`);
      this.handlers.set(type, instance as JobHandlerContract);
    }
  }

  get(type: string): JobHandlerContract | undefined {
    return this.handlers.get(type);
  }

  types(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
