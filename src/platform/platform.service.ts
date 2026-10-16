import { Injectable } from '@nestjs/common';
import { EntitlementsService } from '../organisations/entitlements.service.js';
import type { SubscriptionDto } from '../plans/plans.dto.js';
import { PlansService } from '../plans/plans.service.js';
import { RequestContext } from '../tenancy/request-context.js';
import { DEFAULT_PAGE_SIZE, type PageQueryDto } from '../common/pagination.js';
import { OrganisationsService } from '../organisations/organisations.service.js';
import type {
  PlatformOrganisationPageDto,
  ProvisionedOrganisationDto,
  ProvisionOrganisationDto,
} from './platform.dto.js';
import { PlatformOrganisationsRepository } from './platform-organisations.repository.js';

@Injectable()
export class PlatformService {
  constructor(
    private readonly repository: PlatformOrganisationsRepository,
    private readonly organisations: OrganisationsService,
    private readonly plans: PlansService,
    private readonly entitlements: EntitlementsService,
    private readonly requestContext: RequestContext,
  ) {}

  async list(query: PageQueryDto): Promise<PlatformOrganisationPageDto> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await this.repository.list(limit + 1, query.after ?? null);
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      createdAt: row.createdAt.toISOString(),
      memberCount: row.memberCount,
      ownerCount: row.ownerCount,
      pendingInvitations: row.pendingInvitations,
      planName: row.planName,
    }));
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  }

  async provision(dto: ProvisionOrganisationDto): Promise<ProvisionedOrganisationDto> {
    // the plan is looked up first: an unknown plan must not leave a half-provisioned organisation behind
    const plan = dto.planId ? await this.plans.require(dto.planId) : undefined;
    const organisation = await this.organisations.create(
      { name: dto.name, timezone: dto.timezone },
      { kind: 'invite', email: dto.ownerEmail },
    );
    if (plan) {
      await this.requestContext.runInOrganisation(organisation.id, () =>
        this.entitlements.assign(plan),
      );
    }
    return { ...organisation, ownerEmail: dto.ownerEmail };
  }

  /**
   * Assigns a plan to an organisation (a snapshot of its limits). The platform administrator is not a
   * member: the work runs inside the organisation's own scope, and only this audited path does so.
   */
  async assignPlan(organisationId: string, planId: string): Promise<SubscriptionDto> {
    const plan = await this.plans.require(planId);
    return this.requestContext.runInOrganisation(organisationId, () =>
      this.entitlements.assign(plan),
    );
  }
}
