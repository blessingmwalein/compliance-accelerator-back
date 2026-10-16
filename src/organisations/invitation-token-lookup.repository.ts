import { Injectable } from '@nestjs/common';
import type { Role } from '../permissions/catalogue.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface InvitationByToken {
  invitationId: string;
  organisationId: string;
  organisationName: string;
  email: string;
  role: Role;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  expiresAt: Date;
}

interface Row {
  invitation_id: string;
  organisation_id: string;
  organisation_name: string;
  email: string;
  role: Role;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  expires_at: Date;
}

/**
 * Finds an invitation by the SHA-256 of its emailed token. The invitee has no organisation yet, so
 * this is a pre-tenant read: it calls a SECURITY DEFINER function (migration `rbac_invitations`) that
 * matches the hash exactly and returns that one invitation. Everything after it runs in the
 * invitation's own organisation scope.
 */
@Injectable()
export class InvitationTokenLookupRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(tokenHash: string): Promise<InvitationByToken | null> {
    const rows = await this.prisma.db.$queryRaw<Row[]>`
      SELECT * FROM fca_invitation_by_token(${tokenHash})`;
    const row = rows[0];
    if (!row) return null;
    return {
      invitationId: row.invitation_id,
      organisationId: row.organisation_id,
      organisationName: row.organisation_name,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt: row.expires_at,
    };
  }
}
