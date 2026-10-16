import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage, type PageQueryDto } from '../common/pagination.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { mayAssignRole, type Role } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import { EntitlementsService } from './entitlements.service.js';
import type { ChangeRoleDto, MemberDto, MemberPageDto, MemberVersionDto } from './members.dto.js';
import { MembershipsRepository, type MembershipRecord } from './memberships.repository.js';

export function toMemberDto(record: MembershipRecord): MemberDto {
  return {
    id: record.id,
    userId: record.userId,
    email: record.user.email,
    fullName: record.user.fullName,
    role: record.role,
    status: record.status,
    joinedAt: record.createdAt.toISOString(),
    version: record.version,
  };
}

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Member not found.');
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This member was changed by someone else. Reload and try again.',
  );
const ownerOnly = () =>
  new AppException(
    ErrorCode.OwnerOnly,
    HttpStatus.FORBIDDEN,
    'Only a Company Owner can grant, change or remove the Owner role.',
  );
const selfChange = () =>
  new AppException(
    ErrorCode.SelfChangeNotAllowed,
    HttpStatus.FORBIDDEN,
    'You cannot change your own role or deactivate yourself. Ask another Company Owner.',
  );
const lastOwner = () =>
  new AppException(
    ErrorCode.LastOwner,
    HttpStatus.CONFLICT,
    'An organisation must keep at least one active Company Owner.',
  );

/**
 * Membership administration inside one organisation. Rules beyond the permission check (docs/rbac-matrix.md,
 * section 4): only an Owner touches the Owner role; nobody changes themselves; the last active Owner can
 * never be removed, also under concurrent requests (the active owners are locked first). Every change is
 * versioned (optimistic locking) and audited in the same transaction.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly memberships: MembershipsRepository,
    private readonly audit: AuditService,
    private readonly requestContext: RequestContext,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(query: PageQueryDto): Promise<MemberPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.memberships.list(tx, { limit, ...(query.after ? { after: query.after } : {}) }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toMemberDto), nextCursor: page.nextCursor };
  }

  async changeRole(membershipId: string, dto: ChangeRoleDto): Promise<MemberDto> {
    const actor = this.actor();
    return this.uow.run(async (tx) => {
      // Serialise every change that could remove an owner: two concurrent demotions must not both pass the check.
      const owners = await this.memberships.lockActiveOwners(tx);
      const target = await this.memberships.findById(tx, membershipId);
      if (!target) throw notFound();
      if (target.id === actor.membershipId) throw selfChange();
      if (!mayAssignRole(actor.role, target.role) || !mayAssignRole(actor.role, dto.role)) {
        throw ownerOnly();
      }
      if (target.status !== 'ACTIVE') {
        throw new AppException(
          ErrorCode.Conflict,
          HttpStatus.CONFLICT,
          'Only an active member can be given another role. Reactivate the member first.',
        );
      }
      if (target.version !== dto.version) throw versionConflict();
      if (target.role === dto.role) return toMemberDto(target);
      if (target.role === 'COMPANY_OWNER' && owners.length <= 1) throw lastOwner();

      if (!(await this.memberships.update(tx, target.id, dto.version, { role: dto.role }))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'membership.role_changed',
        entityType: 'membership',
        entityId: target.id,
        entityLabel: target.user.fullName,
        changes: { role: { from: target.role, to: dto.role } },
      });
      return toMemberDto({ ...target, role: dto.role, version: target.version + 1 });
    });
  }

  deactivate(membershipId: string, dto: MemberVersionDto): Promise<MemberDto> {
    const actor = this.actor();
    return this.uow.run(async (tx) => {
      const owners = await this.memberships.lockActiveOwners(tx);
      const target = await this.memberships.findById(tx, membershipId);
      if (!target) throw notFound();
      if (target.id === actor.membershipId) throw selfChange();
      if (!mayAssignRole(actor.role, target.role)) throw ownerOnly();
      if (target.status === 'DEACTIVATED') return toMemberDto(target);
      if (target.version !== dto.version) throw versionConflict();
      if (target.role === 'COMPANY_OWNER' && owners.length <= 1) throw lastOwner();

      if (!(await this.memberships.update(tx, target.id, dto.version, { status: 'DEACTIVATED' }))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'membership.deactivated',
        entityType: 'membership',
        entityId: target.id,
        entityLabel: target.user.fullName,
        changes: { status: { from: 'ACTIVE', to: 'DEACTIVATED' } },
      });
      return toMemberDto({ ...target, status: 'DEACTIVATED', version: target.version + 1 });
    });
  }

  reactivate(membershipId: string, dto: MemberVersionDto): Promise<MemberDto> {
    const actor = this.actor();
    return this.uow.run(async (tx) => {
      const target = await this.memberships.findById(tx, membershipId);
      if (!target) throw notFound();
      if (!mayAssignRole(actor.role, target.role)) throw ownerOnly();
      if (target.status === 'ACTIVE') return toMemberDto(target);
      if (target.version !== dto.version) throw versionConflict();
      await this.entitlements.assertRoomForOneMoreUser(tx); // a returning member takes a seat again

      if (!(await this.memberships.update(tx, target.id, dto.version, { status: 'ACTIVE' }))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'membership.reactivated',
        entityType: 'membership',
        entityId: target.id,
        entityLabel: target.user.fullName,
        changes: { status: { from: 'DEACTIVATED', to: 'ACTIVE' } },
      });
      return toMemberDto({ ...target, status: 'ACTIVE', version: target.version + 1 });
    });
  }

  /** The caller's own membership and role, written to the request scope by the access guard. */
  private actor(): { membershipId: string; role: Role } {
    const { membershipId, role } = this.requestContext.get();
    if (!membershipId || !role) {
      throw new Error('Members service called without a verified membership (programming error)');
    }
    return { membershipId, role };
  }
}
