import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MembershipLookupRepository,
  type MembershipSummary,
} from '../access/membership-lookup.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { uuidv7 } from '../common/uuid.js';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { permissionsOf } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import { InvitationsService } from './invitations.service.js';
import { MembershipsRepository } from './memberships.repository.js';
import { OrganisationsRepository } from './organisations.repository.js';
import type {
  CreateOrganisationDto,
  MyMembershipDto,
  OrganisationSummaryDto,
} from './organisations.dto.js';

/** Who becomes the first Owner of a new organisation. */
export type FirstOwner =
  /** Self-serve: the caller. */
  | { kind: 'member'; userId: string }
  /** Platform provisioning: an email address that is invited (and accepts like any invitee). */
  | { kind: 'invite'; email: string };

@Injectable()
export class OrganisationsService {
  private readonly selfServe: boolean;

  constructor(
    config: ConfigService<EnvironmentVariables, true>,
    private readonly lookup: MembershipLookupRepository,
    private readonly organisations: OrganisationsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly invitations: InvitationsService,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly requestContext: RequestContext,
  ) {
    this.selfServe = config.get('ORGANISATIONS_SELF_SERVE', { infer: true }) === true;
  }

  /** The caller's active organisations. */
  async listMine(userId: string): Promise<OrganisationSummaryDto[]> {
    const rows = await this.lookup.listForUser(userId);
    return rows.map((row) => ({
      id: row.organisationId,
      name: row.name,
      timezone: row.timezone,
      role: row.role,
    }));
  }

  /** The caller's membership in the organisation of the path, as the access guard verified it. */
  describeMembership(organisationId: string, membership: MembershipSummary): MyMembershipDto {
    return {
      organisation: {
        id: organisationId,
        name: membership.organisationName,
        timezone: membership.organisationTimezone,
      },
      membershipId: membership.membershipId,
      role: membership.role,
      permissions: permissionsOf(membership.role),
    };
  }

  /** Self-serve creation: only when `ORGANISATIONS_SELF_SERVE` is on. The caller becomes the first Owner. */
  async createSelfServe(
    userId: string,
    dto: CreateOrganisationDto,
  ): Promise<OrganisationSummaryDto> {
    if (!this.selfServe) {
      throw new AppException(
        ErrorCode.SelfServeDisabled,
        HttpStatus.FORBIDDEN,
        'Organisations are created by a platform administrator. Ask for an invitation.',
      );
    }
    const organisation = await this.create(dto, { kind: 'member', userId });
    return { ...organisation, role: 'COMPANY_OWNER' };
  }

  /**
   * Creates an organisation, its first Owner (membership or invitation) and the audit events in ONE
   * transaction. The id is generated up front because the organisation is also the tenant of the
   * transaction that creates it (row-level security checks it on the very first insert).
   */
  async create(
    dto: CreateOrganisationDto,
    owner: FirstOwner,
  ): Promise<{ id: string; name: string; timezone: string }> {
    const actorUserId = this.requestContext.actorUserId;
    if (!actorUserId) throw new Error('Creating an organisation needs a signed-in actor');
    const id = uuidv7();

    return this.requestContext.runInOrganisation(id, () =>
      this.uow.run(async (tx) => {
        const organisation = await this.organisations.create(tx, {
          id,
          name: dto.name,
          timezone: dto.timezone,
        });
        await this.audit.record(tx, {
          action: 'organisation.created',
          entityType: 'organisation',
          entityId: id,
          entityLabel: organisation.name,
          changes: { name: organisation.name, timezone: organisation.timezone },
        });
        if (owner.kind === 'member') {
          const membership = await this.memberships.create(tx, {
            userId: owner.userId,
            role: 'COMPANY_OWNER',
          });
          await this.audit.record(tx, {
            action: 'membership.created',
            entityType: 'membership',
            entityId: membership.id,
            entityLabel: membership.user.fullName,
            changes: { role: 'COMPANY_OWNER', via: 'organisation created' },
          });
        } else {
          await this.invitations.createWithin(
            tx,
            { email: owner.email, role: 'COMPANY_OWNER' },
            actorUserId,
          );
        }
        return organisation;
      }),
    );
  }
}
