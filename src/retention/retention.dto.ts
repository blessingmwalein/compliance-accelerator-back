import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
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
  DISPOSAL_TARGETS,
  RETENTION_TRIGGERS,
  type RetentionTriggerEvent,
} from '../domain/registers/records.js';
import { REVIEW_STATES } from '../domain/registers/review.js';

/** A query string carries text: `?includeArchived=true` has to arrive as a boolean. */
const toBoolean = ({ value }: { value: unknown }) => value === 'true' || value === true;

/** A calendar date (`YYYY-MM-DD`): stored in a DATE column, judged in the organisation's time zone. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';

/**
 * One retention rule: how long the organisation keeps a class of records, what starts the clock, and how
 * it disposes of them. A period is the organisation's own decision — the platform knows no statutory
 * period and asserts none, so every field here is either what a person entered or null.
 */
export class RetentionRuleDto {
  id!: string;
  name!: string;

  classificationLevelId!: string | null;
  classificationLevelName!: string | null;
  classificationLevelRank!: number | null;

  /** What kind of data the rule covers, in the organisation's own words. */
  dataCategory!: string | null;
  /** Where that data lives (a system, a filing cabinet, a shared drive). */
  systemLocation!: string | null;

  /** What starts the clock. Null = nobody has said yet, which is not the same as "no trigger". */
  @ApiProperty({ enum: RETENTION_TRIGGERS, enumName: 'RetentionTriggerEvent', nullable: true })
  triggerEvent!: RetentionTriggerEvent | null;

  /** Days the records are kept. Null = no period has been decided. */
  retentionPeriodDays!: number | null;
  /** Extra days after the period before disposal; only meaningful when there IS a period. */
  gracePeriodDays!: number | null;
  /** How the records are destroyed, in the organisation's own words. */
  disposalMethod!: string | null;
  /** What the organisation keeps longer or shorter than the rule, and why. */
  exceptions!: string | null;

  ownerMembershipId!: string | null;
  ownerName!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  lastReviewDate!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextReviewDate!: string | null;

  /** `not_reviewed` when there is no due date: an absent date is never "overdue" and never "on time". */
  @ApiProperty({ enum: REVIEW_STATES, enumName: 'ReviewState' })
  reviewState!: (typeof REVIEW_STATES)[number];
  /** Whole days until the due date (negative = past due). Null when there is no due date. */
  daysRemaining!: number | null;

  archived!: boolean;
  archivedAt!: string | null;

  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

/** A legal hold: nothing covered by it may be disposed of, and the hold itself cannot be edited away. */
export class LegalHoldDto {
  id!: string;
  ruleId!: string;
  ruleName!: string;

  /** Null on a blanket hold: it covers everything under its rule. */
  @ApiProperty({ enum: DISPOSAL_TARGETS, enumName: 'DisposalTarget', nullable: true })
  coveredKind!: (typeof DISPOSAL_TARGETS)[number] | null;
  coveredRecordId!: string | null;

  reason!: string;

  placedByUserId!: string;
  placedByName!: string | null;
  placedAt!: string;

  /** Null while the hold is live. */
  releasedAt!: string | null;
  releasedByUserId!: string | null;
  releasedByName!: string | null;
  releaseReason!: string | null;

  /** True when the hold still bites (`releasedAt` is null). */
  active!: boolean;

  /** Send it back when releasing: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

/** One line of the disposal log. It is append-only: what was destroyed cannot be re-written. */
export class RetentionDisposalDto {
  id!: string;
  ruleId!: string;
  ruleName!: string;
  /** The day the disposal was carried out, as the organisation recorded it. */
  @ApiProperty({ type: String, format: 'date' })
  disposedOn!: string;
  note!: string;
  /** How many records it covered; null when the organisation did not count them. */
  itemCount!: number | null;
  createdByUserId!: string;
  createdByName!: string | null;
  createdAt!: string;
}

/** The detail adds what is blocking the rule: its live holds and the disposals logged under it. */
export class RetentionRuleDetailDto extends RetentionRuleDto {
  /** Live holds, oldest first. Empty when nothing is holding the rule. */
  holds!: LegalHoldDto[];
  /** The most recent disposals under this rule, newest first (at most 20). */
  recentDisposals!: RetentionDisposalDto[];
}

export class RetentionRulePageDto {
  items!: RetentionRuleDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class LegalHoldPageDto {
  items!: LegalHoldDto[];
  nextCursor!: string | null;
}

export class RetentionDisposalPageDto {
  items!: RetentionDisposalDto[];
  nextCursor!: string | null;
}

export class ListRetentionRulesQueryDto extends PageQueryDto {
  /** Include archived rules (they are excluded by default). */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;

  @ApiPropertyOptional({ enum: RETENTION_TRIGGERS, enumName: 'RetentionTriggerEvent' })
  @IsOptional()
  @IsIn(RETENTION_TRIGGERS)
  triggerEvent?: RetentionTriggerEvent;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  classificationLevelId?: string;

  /** Only rules whose name, data category or system location contains this text. */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;
}

export class ListLegalHoldsQueryDto extends PageQueryDto {
  /** Only holds on this rule. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ruleId?: string;

  /** `live` = not yet released, `released` = already lifted. Without it, both. */
  @ApiPropertyOptional({ enum: ['live', 'released'], enumName: 'LegalHoldListState' })
  @IsOptional()
  @IsIn(['live', 'released'] as const)
  state?: 'live' | 'released';
}

export class ListRetentionDisposalsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ruleId?: string;
}

export class CreateRetentionRuleDto {
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** An ACTIVE classification level of this organisation. */
  @OptionalOrNull()
  @IsUUID()
  classificationLevelId?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  dataCategory?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  systemLocation?: string | null;

  @OptionalOrNull()
  @IsIn(RETENTION_TRIGGERS)
  triggerEvent?: RetentionTriggerEvent | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(36500)
  retentionPeriodDays?: number | null;

  /** Only allowed together with a period: a grace after nothing is meaningless. */
  @OptionalOrNull()
  @IsInt()
  @Min(0)
  @Max(3660)
  gracePeriodDays?: number | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  disposalMethod?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  exceptions?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  lastReviewDate?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  nextReviewDate?: string | null;
}

export class UpdateRetentionRuleDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @OptionalOrNull()
  @IsUUID()
  classificationLevelId?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  dataCategory?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  systemLocation?: string | null;

  @OptionalOrNull()
  @IsIn(RETENTION_TRIGGERS)
  triggerEvent?: RetentionTriggerEvent | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(36500)
  retentionPeriodDays?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(0)
  @Max(3660)
  gracePeriodDays?: number | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  disposalMethod?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  exceptions?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  lastReviewDate?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  nextReviewDate?: string | null;

  /** The `version` of the rule as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class RetentionRuleVersionDto {
  /** The `version` of the rule as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * Place a hold. Without `coveredKind` the hold is blanket: it covers the whole rule and everything that
 * points at it. With one, the hold covers exactly the record named by `coveredRecordId`.
 */
export class PlaceLegalHoldDto {
  @IsUUID()
  ruleId!: string;

  @OptionalOrNull()
  @IsIn(DISPOSAL_TARGETS)
  coveredKind?: (typeof DISPOSAL_TARGETS)[number] | null;

  @OptionalOrNull()
  @IsUUID()
  coveredRecordId?: string | null;

  /** Why the records must be preserved (a dispute, an investigation, a request). Never a legal claim. */
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class ReleaseLegalHoldDto {
  /** Why the hold can be lifted now. */
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;

  /** The `version` of the hold as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** The organisation states that it carried a disposal out; nothing here deletes any record. */
export class RecordRetentionDisposalDto {
  @IsUUID()
  ruleId!: string;

  @TrimText()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  disposedOn!: string;

  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  note!: string;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(100000000)
  itemCount?: number | null;
}
