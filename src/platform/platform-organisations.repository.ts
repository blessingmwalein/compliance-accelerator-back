import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PlatformOrganisationRecord {
  id: string;
  name: string;
  timezone: string;
  createdAt: Date;
  memberCount: number;
  ownerCount: number;
  pendingInvitations: number;
  planName: string | null;
}

interface Row {
  organisation_id: string;
  name: string;
  timezone: string;
  created_at: Date;
  member_count: bigint;
  owner_count: bigint;
  pending_invitations: bigint;
  plan_name: string | null;
}

/**
 * The platform administrator's cross-organisation list. It reads names and COUNTS only, through a
 * SECURITY DEFINER function (migration `rbac_invitations`), so it works with row-level security on and
 * never exposes any organisation's records. Newest first; the function adds the lookahead row.
 */
@Injectable()
export class PlatformOrganisationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    limitWithLookahead: number,
    after: string | null,
  ): Promise<PlatformOrganisationRecord[]> {
    const rows = await this.prisma.db.$queryRaw<Row[]>`
      SELECT * FROM fca_platform_organisations(${limitWithLookahead}::int, ${after}::uuid)`;
    return rows.map((row) => ({
      id: row.organisation_id,
      name: row.name,
      timezone: row.timezone,
      createdAt: row.created_at,
      memberCount: Number(row.member_count),
      ownerCount: Number(row.owner_count),
      pendingInvitations: Number(row.pending_invitations),
      planName: row.plan_name,
    }));
  }
}
