import { IsBoolean, IsInt, IsUUID, Min } from 'class-validator';

export class PlanDto {
  id!: string;
  /** Stable code, for example `starter`. */
  code!: string;
  name!: string;
  description!: string | null;
  /** The most users a plan allows (active members plus pending invitations); null means unlimited. */
  maxUsers!: number | null;
  apiAccess!: boolean;
  /** Whether the plan is offered. Hiding a plan never changes an organisation that already has it. */
  isVisible!: boolean;
  /** True while the limits are placeholders pending commercial confirmation. */
  isPlaceholder!: boolean;
  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

export class UpdatePlanVisibilityDto {
  @IsBoolean()
  isVisible!: boolean;

  /** The `version` of the plan as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class AssignPlanDto {
  @IsUUID()
  planId!: string;
}

/** What an organisation is entitled to, and how much of it is used. No plan assigned means no limits are enforced. */
export class SubscriptionDto {
  /** False until a platform administrator assigns a plan. */
  assigned!: boolean;
  planCode!: string | null;
  planName!: string | null;
  /** Null = unlimited, and also null while no plan is assigned. */
  maxUsers!: number | null;
  apiAccess!: boolean | null;
  /** ISO 8601 UTC instant the plan was assigned. */
  assignedAt!: string | null;
  /** Members with access now. */
  activeMembers!: number;
  /** Open (not expired) invitations; they count against the plan like members. */
  pendingInvitations!: number;
}
