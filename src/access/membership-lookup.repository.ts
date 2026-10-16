import { Injectable } from '@nestjs/common';
import type { Role } from '../permissions/catalogue.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface MembershipSummary {
  membershipId: string;
  role: Role;
  status: 'ACTIVE' | 'DEACTIVATED';
  version: number;
  organisationName: string;
  organisationTimezone: string;
}

export interface UserOrganisation {
  membershipId: string;
  organisationId: string;
  name: string;
  timezone: string;
  role: Role;
  joinedAt: Date;
}

interface MembershipRow {
  membership_id: string;
  role: Role;
  status: 'ACTIVE' | 'DEACTIVATED';
  membership_version: number;
  organisation_name: string;
  organisation_timezone: string;
}

interface UserOrganisationRow {
  membership_id: string;
  organisation_id: string;
  organisation_name: string;
  organisation_timezone: string;
  role: Role;
  joined_at: Date;
}

/**
 * The reads that happen BEFORE a tenant is known: "is this user a member of this organisation" (the
 * access guard, on every organisation request) and "which organisations does this user belong to".
 * They call SECURITY DEFINER functions (migration `rbac_invitations`) that take only server-verified
 * values and return only the caller's own memberships, so they keep working when row-level security
 * is on. Everything after the guard runs inside a verified tenant scope instead.
 */
@Injectable()
export class MembershipLookupRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(userId: string, organisationId: string): Promise<MembershipSummary | null> {
    const rows = await this.prisma.db.$queryRaw<MembershipRow[]>`
      SELECT * FROM fca_membership_of(${userId}::uuid, ${organisationId}::uuid)`;
    const row = rows[0];
    if (!row) return null;
    return {
      membershipId: row.membership_id,
      role: row.role,
      status: row.status,
      version: row.membership_version,
      organisationName: row.organisation_name,
      organisationTimezone: row.organisation_timezone,
    };
  }

  /** The caller's ACTIVE memberships with their organisations, by organisation name. */
  async listForUser(userId: string): Promise<UserOrganisation[]> {
    const rows = await this.prisma.db.$queryRaw<UserOrganisationRow[]>`
      SELECT * FROM fca_memberships_of_user(${userId}::uuid)`;
    return rows.map((row) => ({
      membershipId: row.membership_id,
      organisationId: row.organisation_id,
      name: row.organisation_name,
      timezone: row.organisation_timezone,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }
}
