import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface NewSecurityEvent {
  eventType: string;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  userId: string | null;
  subjectHash: string | null;
  ipHash: string | null;
  requestId: string | null;
  metadata: unknown;
}

/** Insert-only (the database also forbids UPDATE and DELETE). */
@Injectable()
export class SecurityEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(event: NewSecurityEvent, client: Tx = this.prisma.db): Promise<void> {
    await client.securityEvent.create({
      data: {
        ...event,
        metadata: (event.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true },
    });
  }
}
