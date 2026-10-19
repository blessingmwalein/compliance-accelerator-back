import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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
import { REVIEW_STATES } from '../domain/registers/review.js';
import { ROPA_STATUSES, type RopaActivityStatus } from '../domain/registers/records.js';

/** A calendar date (`YYYY-MM-DD`): stored in a DATE column, judged in the organisation's time zone. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';
/** Every free-text field of an activity: the database CHECK forbids more than this. */
const TEXT_MAX = 2000;

/**
 * One line of the Record of Processing Activities: what personal data is processed, by whom, for what,
 * where it goes and how long it is kept. The text fields are the article 30 columns, and they are empty
 * rather than guessed: a blank field says the organisation has not answered it yet.
 */
export class RopaActivityDto {
  id!: string;
  name!: string;

  businessUnitId!: string | null;
  businessUnitName!: string | null;

  classificationLevelId!: string | null;
  classificationLevelName!: string | null;
  /** Where the level sits in the organisation's scheme (null when no level is set). */
  classificationLevelRank!: number | null;

  /** The retention rule that says how long this processing's records are kept. */
  retentionRuleId!: string | null;
  retentionRuleName!: string | null;

  /** Why the data is processed. */
  purpose!: string | null;
  /** Whose data it is (employees, customers, patients…). */
  dataSubjects!: string | null;
  personalDataCategories!: string | null;
  /** Who the data is disclosed to. */
  recipients!: string | null;
  /** Who processes it on the organisation's behalf. */
  processors!: string | null;
  /** How long it is kept, in words (the rule itself lives in the retention register). */
  retention!: string | null;
  internationalTransfers!: string | null;
  transferCountries!: string | null;
  securityMeasures!: string | null;

  ownerMembershipId!: string | null;
  ownerName!: string | null;

  @ApiProperty({ enum: ROPA_STATUSES, enumName: 'RopaActivityStatus' })
  status!: RopaActivityStatus;

  /** The review cadence this record states, in days. Metadata only: it never invents a due date. */
  reviewIntervalDays!: number | null;
  /** Days before the due date from which it counts as due soon. Null = the reference lead window (30). */
  reviewLeadDays!: number | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  lastReviewDate!: string | null;
  /** The approved day the next review is due, or null when nobody has set one. */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextReviewDate!: string | null;

  /** `not_reviewed` when there is no due date: an absent date is never "overdue" and never "on time". */
  @ApiProperty({ enum: REVIEW_STATES, enumName: 'ReviewState' })
  reviewState!: (typeof REVIEW_STATES)[number];

  /** Whole days until the due date (negative = past due). Null when there is no due date. */
  daysRemaining!: number | null;

  /** True once archived: hidden from pickers, kept for history. */
  archived!: boolean;
  archivedAt!: string | null;

  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

/** The detail adds the evidence linked to this activity (a list row does not carry it). */
export class RopaActivityDetailDto extends RopaActivityDto {
  /** Evidence ids, oldest link first. */
  evidenceIds!: string[];
}

export class RopaActivityPageDto {
  items!: RopaActivityDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class ListRopaActivitiesQueryDto extends PageQueryDto {
  /** Exactly this status. Without it, archived activities are excluded. */
  @ApiPropertyOptional({ enum: ROPA_STATUSES, enumName: 'RopaActivityStatus' })
  @IsOptional()
  @IsIn(ROPA_STATUSES)
  status?: RopaActivityStatus;

  /** Only activities of this business unit. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  businessUnitId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  classificationLevelId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  retentionRuleId?: string;

  /** Only activities whose name or purpose contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;
}

/** The monitor: how much of the register needs a review, decided on the server in the organisation's zone. */
export class RopaMonitorDto {
  /**
   * `no_records`: the register is empty. `not_configured`: no activity has a review due date, so there is
   * nothing to monitor. `ok`: the counts below are real.
   */
  @ApiProperty({
    enum: ['ok', 'no_records', 'not_configured'],
    enumName: 'RopaMonitorAvailability',
  })
  availability!: 'ok' | 'no_records' | 'not_configured';

  /** Today in the organisation's time zone: the day the counts were decided against. */
  asOf!: string;

  /** Live (non-archived) activities counted. */
  total!: number;
  overdue!: number;
  dueSoon!: number;
  /** Reviewed in time, or with a due date far enough away not to be due soon. */
  onTrack!: number;
  /** No approved due date at all — an open question, not a pass. */
  notReviewed!: number;
}

export class CreateRopaActivityDto {
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @OptionalOrNull()
  @IsUUID()
  businessUnitId?: string | null;

  /** An ACTIVE classification level of this organisation. */
  @OptionalOrNull()
  @IsUUID()
  classificationLevelId?: string | null;

  /** An ACTIVE retention rule of this organisation. */
  @OptionalOrNull()
  @IsUUID()
  retentionRuleId?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  purpose?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  dataSubjects?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  personalDataCategories?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  recipients?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  processors?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  retention?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  internationalTransfers?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  transferCountries?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  securityMeasures?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  /** A new activity starts as `DRAFT`; `ARCHIVED` is only ever set by the archive endpoint. */
  @ApiPropertyOptional({ enum: ['DRAFT', 'ACTIVE'], enumName: 'RopaActivityInitialStatus' })
  @IsOptional()
  @IsIn(['DRAFT', 'ACTIVE'] as const)
  status?: 'DRAFT' | 'ACTIVE';

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(3660)
  reviewIntervalDays?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(0)
  @Max(366)
  reviewLeadDays?: number | null;

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

export class UpdateRopaActivityDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @OptionalOrNull()
  @IsUUID()
  businessUnitId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  classificationLevelId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  retentionRuleId?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  purpose?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  dataSubjects?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  personalDataCategories?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  recipients?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  processors?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  retention?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  internationalTransfers?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  transferCountries?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(TEXT_MAX)
  securityMeasures?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  /** `DRAFT` ↔ `ACTIVE`. Archiving and restoring have their own endpoints. */
  @ApiPropertyOptional({ enum: ['DRAFT', 'ACTIVE'], enumName: 'RopaActivityInitialStatus' })
  @IsOptional()
  @IsIn(['DRAFT', 'ACTIVE'] as const)
  status?: 'DRAFT' | 'ACTIVE';

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(3660)
  reviewIntervalDays?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(0)
  @Max(366)
  reviewLeadDays?: number | null;

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

  /** The `version` of the activity as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class RopaActivityVersionDto {
  /** The `version` of the activity as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** Linking an evidence file to an activity: the file itself is uploaded through the evidence endpoints. */
export class LinkRopaEvidenceDto {
  @IsUUID()
  evidenceId!: string;
}
