import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { Prisma } from '../generated/prisma/client.js';
import type { InputJsonValue } from '../generated/prisma/internal/prismaNamespace.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface PolicyRecord {
  id: string;
  exposureThresholds: unknown;
  remediationDueDays: unknown;
  planWindowDays: unknown;
  version: number;
}

export interface PolicyChanges {
  exposureThresholds?: InputJsonValue | null;
  remediationDueDays?: InputJsonValue | null;
  planWindowDays?: InputJsonValue | null;
}

const SELECT = {
  id: true,
  exposureThresholds: true,
  remediationDueDays: true,
  planWindowDays: true,
  version: true,
} as const;

/** The scoring and scheduling policy of the CURRENT organisation (one row at most). */
@Injectable()
export class ScoringPolicyRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  get(tx: Tx): Promise<PolicyRecord | null> {
    return tx.assessmentPolicy.findFirst({
      where: { organisationId: this.organisationId },
      select: SELECT,
    });
  }

  create(tx: Tx, changes: PolicyChanges): Promise<PolicyRecord> {
    return tx.assessmentPolicy.create({
      data: {
        organisationId: this.organisationId,
        ...nullable(changes),
      },
      select: SELECT,
    });
  }

  async update(tx: Tx, id: string, version: number, changes: PolicyChanges): Promise<boolean> {
    const result = await tx.assessmentPolicy.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...nullable(changes), version: { increment: 1 } },
    });
    return result.count === 1;
  }
}

/** Prisma needs `Prisma.DbNull` (not `null`) to store a JSON column as SQL NULL. */
function nullable(changes: PolicyChanges) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    out[key] = value === null ? Prisma.DbNull : value;
  }
  return out;
}
