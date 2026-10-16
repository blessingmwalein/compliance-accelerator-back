import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** One row per attempt to send, keyed on the recipient ADDRESS (not a user). */
@Injectable()
export class EmailDeliveriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: { toAddress: string; template: string }): Promise<{ id: string }> {
    return this.prisma.db.emailDelivery.create({
      data: { ...data, attempts: 1 },
      select: { id: true },
    });
  }

  async markSent(id: string, providerMessageId: string): Promise<void> {
    await this.prisma.db.emailDelivery.update({
      where: { id },
      data: { status: 'SENT', providerMessageId, sentAt: new Date() },
    });
  }

  /** `error` must already be sanitised (no addresses, no tokens). */
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.db.emailDelivery.update({
      where: { id },
      data: { status: 'FAILED', lastError: error },
    });
  }
}
