import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { OptionalOrNull, TrimText, TrimToNull } from '../common/validators/nullable.js';
import {
  ACCEPTANCE_DECISIONS,
  RISK_CATEGORIES,
  RISK_STATUSES,
  type AcceptanceDecision,
  type RiskCategory,
  type RiskStatus,
} from '../domain/risk/policy.js';
import { RISK_LEVELS, type RiskLevel } from '../domain/scoring/methodologies.js';
import { REVIEW_STATES } from '../domain/registers/review.js';

const toBoolean = ({ value }: { value: unknown }) => value === 'true' || value === true;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';

/** What the server derived from the two factors: never accepted from the client. */
export class RiskScoreDto {
  likelihood!: number | null;
  severity!: number | null;
  /** likelihood × severity. Null when either factor is missing. */
  score!: number | null;
  @ApiProperty({ enum: RISK_LEVELS, enumName: 'RiskLevel', nullable: true })
  level!: RiskLevel | null;
}

export class RiskStatusTransitionDto {
  @ApiProperty({ enum: RISK_STATUSES, enumName: 'RiskStatus' })
  toStatus!: RiskStatus;
  /** `approve`: only an approver may take this step. `work`: anyone who may edit the register. */
  @ApiProperty({ enum: ['work', 'approve'] })
  by!: 'work' | 'approve';
  /** A written reason has to come with the step. */
  needsReason!: boolean;
}

/**
 * A risk the organisation tracks. The two factor pairs are what a person entered; the score and the level
 * are derived by the server from them under `risk_matrix_v1` and cannot be sent.
 */
export class RiskDto {
  id!: string;
  title!: string;
  description!: string | null;

  @ApiProperty({ enum: RISK_CATEGORIES, enumName: 'RiskCategory', nullable: true })
  category!: RiskCategory | null;

  @ApiProperty({ enum: RISK_STATUSES, enumName: 'RiskStatus' })
  status!: RiskStatus;

  governanceAreaId!: string | null;
  governanceAreaName!: string | null;
  requirementId!: string | null;
  requirementRef!: string | null;
  requirementTitle!: string | null;
  /** The assessment item this risk was raised from, when there is one. */
  assessmentItemId!: string | null;
  businessUnitId!: string | null;
  businessUnitName!: string | null;
  frameworkId!: string | null;
  frameworkCode!: string | null;

  ownerMembershipId!: string | null;
  ownerName!: string | null;
  /** What the organisation is doing about it, in its own words. */
  treatmentPlan!: string | null;

  /** The risk before any control: the two factors, their product, and the band that product falls in. */
  inherent!: RiskScoreDto;
  /** The risk that is left after the controls. Neither factor may exceed its inherent counterpart. */
  residual!: RiskScoreDto;

  /** Which methodology decided the band, so a future change of bands cannot rewrite history. */
  methodologyId!: string;
  methodologyVersion!: number;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  identifiedOn!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  reviewByDate!: string | null;

  /** `not_reviewed` when there is no date: an absent date is never "overdue" and never "on time". */
  @ApiProperty({ enum: REVIEW_STATES, enumName: 'ReviewState' })
  reviewState!: (typeof REVIEW_STATES)[number];
  daysRemaining!: number | null;

  createdByUserId!: string;
  createdAt!: string;
  updatedAt!: string;

  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;

  /** The steps THIS caller may take now, so the UI never offers a forbidden one. */
  @ApiProperty({ type: [RiskStatusTransitionDto] })
  allowedTransitions!: RiskStatusTransitionDto[];
}

/** The detail adds the acceptance ledger and whether an acceptance is in force right now. */
export class RiskDetailDto extends RiskDto {
  /** Newest decision first: the history of every time this risk was accepted and withdrawn. */
  acceptances!: RiskAcceptanceDto[];
  /** True when the newest ledger row is an ACCEPTED decision. */
  acceptanceInForce!: boolean;
}

/** One decision in the acceptance ledger. The ledger is append-only: a decision is never edited away. */
export class RiskAcceptanceDto {
  id!: string;
  riskId!: string;
  @ApiProperty({ enum: ACCEPTANCE_DECISIONS, enumName: 'RiskAcceptanceDecision' })
  decision!: AcceptanceDecision;
  rationale!: string;
  decidedByUserId!: string;
  decidedByName!: string | null;
  decidedAt!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  expiresOn!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  reviewOn!: string | null;
}

export class RiskPageDto {
  items!: RiskDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class RiskAcceptancePageDto {
  items!: RiskAcceptanceDto[];
  nextCursor!: string | null;
}

export class ListRisksQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: RISK_STATUSES, enumName: 'RiskStatus' })
  @IsOptional()
  @IsIn(RISK_STATUSES)
  status?: RiskStatus;

  @ApiPropertyOptional({ enum: RISK_CATEGORIES, enumName: 'RiskCategory' })
  @IsOptional()
  @IsIn(RISK_CATEGORIES)
  category?: RiskCategory;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  businessUnitId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  governanceAreaId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ownerMembershipId?: string;

  /** Only risks whose review is due on or before this calendar day. */
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  reviewDueBy?: string;

  /**
   * Which factor pair `likelihood` and `severity` are read against. `residual` is what the organisation
   * still carries, and is what the heat map plots by default, so a cell and its drill-down agree.
   */
  @ApiPropertyOptional({
    enum: ['residual', 'inherent'],
    enumName: 'RiskHeatmapBasis',
    default: 'residual',
  })
  @IsOptional()
  @IsIn(['residual', 'inherent'] as const)
  basis?: 'residual' | 'inherent';

  /** Only risks at this likelihood on the chosen basis: one step of a heat-map drill-down. */
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  likelihood?: number;

  /** Only risks at this severity on the chosen basis; the other half of the cell. */
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  severity?: number;

  /** Only risks whose title or description contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Include CLOSED risks (they are listed by default; set this to false to hide them). */
  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeClosed?: boolean;
}

/** A new risk: the factors a person states, and nothing derived among them. */
export class CreateRiskDto {
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @OptionalOrNull()
  @IsIn(RISK_CATEGORIES)
  category?: RiskCategory | null;

  @OptionalOrNull()
  @IsUUID()
  governanceAreaId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  requirementId?: string | null;

  /** An assessment item of this organisation: the risk records where it came from. */
  @OptionalOrNull()
  @IsUUID()
  assessmentItemId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  businessUnitId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  frameworkId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(4000)
  treatmentPlan?: string | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  inherentLikelihood?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  inherentSeverity?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  residualLikelihood?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  residualSeverity?: number | null;

  @TrimToNull()
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  identifiedOn?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  reviewByDate?: string | null;

  /** A new risk is OPEN: acceptance is a separate decision, taken against a row that exists. */
  @ApiPropertyOptional({ enum: ['OPEN', 'IN_TREATMENT'], enumName: 'RiskInitialStatus' })
  @IsOptional()
  @IsIn(['OPEN', 'IN_TREATMENT'] as const)
  status?: 'OPEN' | 'IN_TREATMENT';
}

export class UpdateRiskDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @OptionalOrNull()
  @IsIn(RISK_CATEGORIES)
  category?: RiskCategory | null;

  @OptionalOrNull()
  @IsUUID()
  governanceAreaId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  requirementId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  assessmentItemId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  businessUnitId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  frameworkId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  treatmentPlan?: string | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  inherentLikelihood?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  inherentSeverity?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  residualLikelihood?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  residualSeverity?: number | null;

  @TrimToNull()
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  identifiedOn?: string | null;

  @TrimToNull()
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  reviewByDate?: string | null;

  /** The `version` of the risk as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class ChangeRiskStatusDto {
  @ApiProperty({ enum: RISK_STATUSES, enumName: 'RiskStatus' })
  @IsIn(RISK_STATUSES)
  toStatus!: RiskStatus;

  /** Mandatory for the steps that say so (and always kept: a status change is a decision). */
  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** Accept the residual risk: a decision with a rationale, optionally bounded by a date. */
export class AcceptRiskDto {
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  rationale!: string;

  /** The acceptance stops counting on this day; null = until it is withdrawn. */
  @TrimToNull()
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  expiresOn?: string | null;

  /** When the acceptance has to be looked at again; must not be after `expiresOn`. */
  @TrimToNull()
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  reviewOn?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** Stop accepting it, and say where the risk goes instead. */
export class WithdrawRiskAcceptanceDto {
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  rationale!: string;

  /** The ledger row is only one half of the decision: the status has to move as well. */
  @ApiProperty({ enum: ['OPEN', 'IN_TREATMENT'], enumName: 'RiskInitialStatus' })
  @IsIn(['OPEN', 'IN_TREATMENT'] as const)
  toStatus!: 'OPEN' | 'IN_TREATMENT';

  @IsInt()
  @Min(1)
  version!: number;
}

/** The register's counts, decided on the server in the organisation's own zone. */
export class RiskSummaryDto {
  @ApiProperty({ enum: ['ok', 'no_records'], enumName: 'MetricAvailability' })
  availability!: 'ok' | 'no_records';
  /** Today in the organisation's time zone: the day the counts were decided against. */
  asOf!: string;
  /** Risks that are not CLOSED (a closed risk is history, not exposure). */
  total!: number;

  byStatus!: Record<RiskStatus, number>;
  /** OPEN plus IN_TREATMENT: the risks somebody still has to act on. */
  open!: number;

  /** Where the exposure sits, counted on the chosen basis, over the risks that are not CLOSED. */
  byResidualLevel!: Record<RiskLevel | 'NOT_SCORED', number>;
  byInherentLevel!: Record<RiskLevel | 'NOT_SCORED', number>;

  reviews!: {
    overdue: number;
    dueSoon: number;
    ok: number;
    /** No review date at all — an open question, not a pass. */
    notScheduled: number;
  };
  /** Risks whose acceptance has an expiry date that has passed, or is about to. */
  acceptancesExpiring: number;
}

export class HeatmapCellDto {
  /** 1-5, the likelihood axis. */
  likelihood!: number;
  /** 1-5, the severity axis. */
  severity!: number;
  count!: number;
  /** The band this cell falls in, from the same reference bands the rows carry. */
  @ApiProperty({ enum: RISK_LEVELS, enumName: 'RiskLevel', nullable: true })
  level!: RiskLevel | null;
}

export class RiskHeatmapQueryDto {
  /** Which pair the grid is plotted from. `residual` is what the organisation still carries. */
  @ApiPropertyOptional({
    enum: ['residual', 'inherent'],
    enumName: 'RiskHeatmapBasis',
    default: 'residual',
  })
  @IsOptional()
  @IsIn(['residual', 'inherent'] as const)
  basis?: 'residual' | 'inherent';
}

/** The five by five grid. Risks with a missing factor pair are counted separately, never guessed. */
export class RiskHeatmapDto {
  @ApiProperty({ enum: ['residual', 'inherent'], enumName: 'RiskHeatmapBasis' })
  basis!: 'residual' | 'inherent';
  @ApiProperty({ enum: ['ok', 'no_records'], enumName: 'MetricAvailability' })
  availability!: 'ok' | 'no_records';
  asOf!: string;
  @ApiProperty({ type: [HeatmapCellDto] })
  cells!: HeatmapCellDto[];
  /** Risks on this basis with no complete factor pair: they are in the register but not on the grid. */
  unscored!: number;
}
