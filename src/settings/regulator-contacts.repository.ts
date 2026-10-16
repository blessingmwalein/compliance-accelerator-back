import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface RegulatorContactRecord {
  id: string;
  authorityName: string;
  jurisdiction: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  version: number;
}

export type RegulatorContactFields = Omit<RegulatorContactRecord, 'id' | 'version'>;

const SELECT = {
  id: true,
  authorityName: true,
  jurisdiction: true,
  contactName: true,
  email: true,
  phone: true,
  notes: true,
  version: true,
} as const;

@Injectable()
export class RegulatorContactsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  list(tx: Tx, options: { limit: number; after?: string }): Promise<RegulatorContactRecord[]> {
    return tx.regulatorContact.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.after ? { id: { gt: options.after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
  }

  findById(tx: Tx, id: string): Promise<RegulatorContactRecord | null> {
    return tx.regulatorContact.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  create(tx: Tx, data: RegulatorContactFields): Promise<RegulatorContactRecord> {
    return tx.regulatorContact.create({
      data: { ...data, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<RegulatorContactFields>,
  ): Promise<boolean> {
    const result = await tx.regulatorContact.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  async delete(tx: Tx, id: string): Promise<boolean> {
    const result = await tx.regulatorContact.deleteMany({
      where: { id, organisationId: this.organisationId },
    });
    return result.count === 1;
  }
}
