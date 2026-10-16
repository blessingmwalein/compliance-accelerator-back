import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PlanRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  maxUsers: number | null;
  apiAccess: boolean;
  isVisible: boolean;
  isPlaceholder: boolean;
  version: number;
}

const SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  maxUsers: true,
  apiAccess: true,
  isVisible: true,
  isPlaceholder: true,
  version: true,
} as const;

/** Subscription plans: global, platform-managed reference data (no tenant column). */
@Injectable()
export class PlansRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(options: { visibleOnly: boolean }): Promise<PlanRecord[]> {
    return this.prisma.db.plan.findMany({
      where: options.visibleOnly ? { isVisible: true } : {},
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: SELECT,
    });
  }

  findById(id: string, client: Tx = this.prisma.db): Promise<PlanRecord | null> {
    return client.plan.findUnique({ where: { id }, select: SELECT });
  }

  async setVisibility(id: string, version: number, isVisible: boolean): Promise<boolean> {
    const result = await this.prisma.db.plan.updateMany({
      where: { id, version },
      data: { isVisible, version: { increment: 1 } },
    });
    return result.count === 1;
  }
}
