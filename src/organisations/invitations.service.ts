import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { sha256Hex } from '../auth/tokens.js';
import { UsersRepository } from '../auth/users.repository.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { Clock } from '../common/clock.js';
import { pageSizeOf, toPage, type PageQueryDto } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { JobsService } from '../jobs/jobs.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { mayAssignRole, type Role } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import {
  INVITATION_JOB_TYPES,
  INVITATION_SEND_WINDOW_MS,
  INVITATION_TTL_MS,
  type InvitationJobPayload,
} from './invitation-jobs.js';
import { InvitationTokenLookupRepository } from './invitation-token-lookup.repository.js';
import type {
  CreateInvitationDto,
  InvitationAcceptedDto,
  InvitationDto,
  InvitationPageDto,
  InvitationPreviewDto,
  InvitationState,
} from './invitations.dto.js';
import { InvitationsRepository, type InvitationRecord } from './invitations.repository.js';
import { MembershipsRepository } from './memberships.repository.js';

export function invitationState(record: InvitationRecord, now: Date): InvitationState {
  if (record.status === 'PENDING' && record.expiresAt <= now) return 'EXPIRED';
  return record.status;
}

const toDto = (record: InvitationRecord, now: Date): InvitationDto => ({
  id: record.id,
  email: record.email,
  role: record.role,
  state: invitationState(record, now),
  expiresAt: record.expiresAt.toISOString(),
  sendCount: record.sendCount,
  invitedByName: record.invitedBy.fullName,
  createdAt: record.createdAt.toISOString(),
  version: record.version,
});

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Invitation not found.');
/** One answer for every way a token can be unusable (unknown, expired, used, revoked, replaced): it reveals nothing. */
const invalidToken = () =>
  new AppException(
    ErrorCode.InvalidToken,
    HttpStatus.BAD_REQUEST,
    'This invitation link is invalid or has expired.',
  );
const ownerOnly = () =>
  new AppException(
    ErrorCode.OwnerOnly,
    HttpStatus.FORBIDDEN,
    'Only a Company Owner can grant the Owner role.',
  );

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'P2002';

/**
 * Invitations (ADR-0003/0005). An invitation is an offer to an email ADDRESS; the person accepts it
 * while signed in with that same address. The emailed token is created by the email JOB at send
 * time, so the database and the job payload never hold a usable secret. Accepting is a POST from an
 * SPA page, never a GET link handler (mail scanners prefetch GETs).
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly invitations: InvitationsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly lookup: InvitationTokenLookupRepository,
    private readonly users: UsersRepository,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly requestContext: RequestContext,
    private readonly clock: Clock,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(query: PageQueryDto): Promise<InvitationPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.invitations.list(tx, { limit, ...(query.after ? { after: query.after } : {}) }),
    );
    const page = toPage(rows, limit);
    const now = this.clock.now();
    return { items: page.items.map((row) => toDto(row, now)), nextCursor: page.nextCursor };
  }

  async create(dto: CreateInvitationDto): Promise<InvitationDto> {
    const { role, userId } = this.actor();
    if (!mayAssignRole(role, dto.role)) throw ownerOnly();
    try {
      const record = await this.uow.run((tx) => this.createWithin(tx, dto, userId));
      return toDto(record, this.clock.now());
    } catch (error) {
      // Two concurrent invitations for one address: the partial unique index lets exactly one win.
      if (isUniqueViolation(error)) throw this.pending();
      throw error;
    }
  }

  /**
   * Creates the invitation, queues its email and audits it, inside the caller's transaction. Also used
   * when a platform administrator provisions an organisation and invites its first Owner.
   */
  async createWithin(
    tx: Tx,
    dto: CreateInvitationDto,
    invitedByUserId: string,
  ): Promise<InvitationRecord> {
    const now = this.clock.now();

    const existingUser = await this.users.findByEmail(dto.email, tx);
    if (existingUser) {
      const membership = await this.memberships.findByUser(tx, existingUser.id);
      if (membership?.status === 'ACTIVE') {
        throw new AppException(
          ErrorCode.AlreadyMember,
          HttpStatus.CONFLICT,
          'This person is already a member of the organisation.',
        );
      }
    }

    const pending = await this.invitations.findPendingByEmail(tx, dto.email);
    if (pending) {
      if (pending.expiresAt > now) throw this.pending();
      // An expired offer must not block a new one (the database allows one PENDING row per address).
      await this.invitations.revoke(tx, pending.id, now);
      await this.audit.record(tx, {
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: pending.id,
        entityLabel: pending.email,
        changes: { reason: 'expired and replaced by a new invitation' },
      });
    }

    // the plan's user limit counts members and open invitations (no plan assigned = no limit)
    await this.entitlements.assertRoomForOneMoreUser(tx);

    const record = await this.invitations.create(tx, {
      email: dto.email,
      role: dto.role,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      invitedByUserId,
    });
    await this.enqueueSend(tx, record.id, now);
    await this.audit.record(tx, {
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: record.id,
      entityLabel: record.email,
      changes: { role: record.role },
    });
    return record;
  }

  async resend(id: string): Promise<InvitationDto> {
    return this.uow.run(async (tx) => {
      const record = await this.invitations.findById(tx, id);
      if (!record) throw notFound();
      if (record.status !== 'PENDING') {
        throw new AppException(
          ErrorCode.Conflict,
          HttpStatus.CONFLICT,
          'Only a pending invitation can be sent again.',
        );
      }
      const now = this.clock.now();
      const queued = await this.enqueueSend(tx, record.id, now);
      if (queued) {
        await this.audit.record(tx, {
          action: 'invitation.resent',
          entityType: 'invitation',
          entityId: record.id,
          entityLabel: record.email,
        });
      }
      return toDto(record, now);
    });
  }

  async revoke(id: string): Promise<InvitationDto> {
    return this.uow.run(async (tx) => {
      const record = await this.invitations.findById(tx, id);
      if (!record) throw notFound();
      const now = this.clock.now();
      if (record.status === 'REVOKED') return toDto(record, now);
      if (record.status === 'ACCEPTED') {
        throw new AppException(
          ErrorCode.Conflict,
          HttpStatus.CONFLICT,
          'This invitation was already accepted. Deactivate the member instead.',
        );
      }
      await this.invitations.revoke(tx, record.id, now);
      await this.audit.record(tx, {
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: record.id,
        entityLabel: record.email,
      });
      return toDto({ ...record, status: 'REVOKED', version: record.version + 1 }, now);
    });
  }

  /** What the link offers, shown before the invitee accepts. Anything unusable is one uniform error. */
  async inspect(token: string): Promise<InvitationPreviewDto> {
    const found = await this.lookup.find(sha256Hex(token));
    if (!found || found.status !== 'PENDING' || found.expiresAt <= this.clock.now()) {
      throw invalidToken();
    }
    return {
      organisationName: found.organisationName,
      role: found.role,
      expiresAt: found.expiresAt.toISOString(),
    };
  }

  /** Accepts for the signed-in user, who must have confirmed the invited address. Returns where they now belong. */
  async accept(userId: string, token: string): Promise<InvitationAcceptedDto> {
    const user = await this.users.findById(userId);
    if (!user || !user.isActive) throw invalidToken();
    if (!user.emailVerifiedAt) {
      throw new AppException(
        ErrorCode.EmailNotVerified,
        HttpStatus.FORBIDDEN,
        'Confirm your email address before accepting an invitation.',
      );
    }

    const tokenHash = sha256Hex(token);
    const found = await this.lookup.find(tokenHash);
    const now = this.clock.now();
    if (!found || found.status !== 'PENDING' || found.expiresAt <= now) throw invalidToken();
    if (found.email !== user.email) {
      throw new AppException(
        ErrorCode.InvitationEmailMismatch,
        HttpStatus.FORBIDDEN,
        'This invitation was sent to a different email address. Sign in with the address the invitation was sent to.',
      );
    }

    await this.requestContext.runInOrganisation(found.organisationId, () =>
      this.uow.run(async (tx) => {
        if (!(await this.invitations.accept(tx, found.invitationId, tokenHash, userId, now))) {
          throw invalidToken(); // consumed or replaced between the lookup and now
        }
        const existing = await this.memberships.findByUser(tx, userId);
        if (existing?.status === 'ACTIVE') {
          throw new AppException(
            ErrorCode.AlreadyMember,
            HttpStatus.CONFLICT,
            'You are already a member of this organisation.',
          );
        }
        if (existing) {
          // A deactivated member rejoins with the role they were just invited to.
          await this.memberships.update(tx, existing.id, existing.version, {
            status: 'ACTIVE',
            role: found.role,
          });
          await this.audit.record(tx, {
            action: 'membership.reactivated',
            entityType: 'membership',
            entityId: existing.id,
            entityLabel: user.fullName,
            changes: { role: found.role, via: 'invitation' },
          });
        } else {
          const created = await this.memberships.create(tx, { userId, role: found.role });
          await this.audit.record(tx, {
            action: 'membership.created',
            entityType: 'membership',
            entityId: created.id,
            entityLabel: user.fullName,
            changes: { role: found.role, via: 'invitation' },
          });
        }
        await this.audit.record(tx, {
          action: 'invitation.accepted',
          entityType: 'invitation',
          entityId: found.invitationId,
          entityLabel: found.email,
        });
      }),
    );
    return { organisationId: found.organisationId, role: found.role };
  }

  private pending(): AppException {
    return new AppException(
      ErrorCode.InvitationPending,
      HttpStatus.CONFLICT,
      'There is already a pending invitation for this address. Resend or revoke it instead.',
    );
  }

  /** Queues the email job, deduplicated per 5-minute window. Returns whether a job was added. */
  private enqueueSend(tx: Tx, invitationId: string, now: Date): Promise<boolean> {
    const organisationId = this.requestContext.requireOrganisationId();
    const payload: InvitationJobPayload = { organisationId, invitationId };
    const window = Math.floor(now.getTime() / INVITATION_SEND_WINDOW_MS);
    return this.jobs.enqueue(
      {
        type: INVITATION_JOB_TYPES.send,
        payload: { ...payload },
        dedupeKey: `${INVITATION_JOB_TYPES.send}:${invitationId}:${window}`,
      },
      tx,
    );
  }

  private actor(): { userId: string; role: Role } {
    const { actorUserId, role } = this.requestContext.get();
    if (!actorUserId || !role) {
      throw new Error('Invitations called without a verified member (programming error)');
    }
    return { userId: actorUserId, role };
  }
}
