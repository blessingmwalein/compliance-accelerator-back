import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type { SubscriptionDto } from '../plans/plans.dto.js';
import type { PlanRecord } from '../plans/plans.repository.js';
import { RequestContext } from '../tenancy/request-context.js';
import { EntitlementsRepository } from './entitlements.repository.js';
import { OrganisationsRepository } from './organisations.repository.js';

/**
 * What an organisation may use, from its plan snapshot. With NO plan assigned nothing is limited: a
 * missing plan is "not configured", never "zero users allowed". The user limit counts active members
 * plus open invitations, and is checked when inviting or reactivating a member.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly entitlements: EntitlementsRepository,
    private readonly organisations: OrganisationsRepository,
    private readonly audit: AuditService,
    private readonly requestContext: RequestContext,
    private readonly clock: Clock,
  ) {}

  /** Throws `USER_LIMIT_REACHED` when one more member would exceed the plan's user limit. Call inside the unit of work. */
  async assertRoomForOneMoreUser(tx: Tx): Promise<void> {
    const entitlement = await this.entitlements.get(tx);
    if (!entitlement || entitlement.maxUsers === null) return;
    const used =
      (await this.entitlements.countActiveMembers(tx)) +
      (await this.entitlements.countOpenInvitations(tx, this.clock.now()));
    if (used >= entitlement.maxUsers) {
      throw new AppException(
        ErrorCode.UserLimitReached,
        HttpStatus.FORBIDDEN,
        `The ${entitlement.planName} plan allows ${entitlement.maxUsers} users, counting open invitations, and all of them are in use. Ask a platform administrator to change the plan.`,
      );
    }
  }

  describe(): Promise<SubscriptionDto> {
    return this.uow.run((tx) => this.build(tx));
  }

  /** Assigns a plan: the organisation gets a SNAPSHOT of its limits. Platform administrators call this inside the organisation's scope. */
  assign(plan: PlanRecord): Promise<SubscriptionDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const actorUserId = this.requestContext.actorUserId;
    if (!actorUserId) throw new Error('Assigning a plan needs a signed-in actor');

    return this.uow.run(async (tx) => {
      const organisation = await this.organisations.findById(tx, organisationId);
      if (!organisation) {
        throw new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Organisation not found.');
      }
      await this.entitlements.upsert(tx, {
        planId: plan.id,
        planCode: plan.code,
        planName: plan.name,
        maxUsers: plan.maxUsers,
        apiAccess: plan.apiAccess,
        assignedByUserId: actorUserId,
      });
      await this.audit.record(tx, {
        action: 'entitlement.assigned',
        entityType: 'organisation',
        entityId: organisationId,
        entityLabel: organisation.name,
        changes: { plan: plan.code, maxUsers: plan.maxUsers, apiAccess: plan.apiAccess },
      });
      return this.build(tx);
    });
  }

  private async build(tx: Tx): Promise<SubscriptionDto> {
    const entitlement = await this.entitlements.get(tx);
    const [activeMembers, pendingInvitations] = [
      await this.entitlements.countActiveMembers(tx),
      await this.entitlements.countOpenInvitations(tx, this.clock.now()),
    ];
    return {
      assigned: entitlement !== null,
      planCode: entitlement?.planCode ?? null,
      planName: entitlement?.planName ?? null,
      maxUsers: entitlement?.maxUsers ?? null,
      apiAccess: entitlement?.apiAccess ?? null,
      assignedAt: entitlement?.assignedAt.toISOString() ?? null,
      activeMembers,
      pendingInvitations,
    };
  }
}
