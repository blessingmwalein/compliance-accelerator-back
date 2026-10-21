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
import {
  LAWFUL_BASES,
  LAWFUL_BASIS_REVIEW_STATUSES,
  ROPA_STATUSES,
  type LawfulBasisKind,
  type LawfulBasisReviewStatus,
  type RopaActivityStatus,
} from '../domain/registers/records.js';

/** A calendar date (`YYYY-MM-DD`): stored in a DATE column, judged in the organisation's time zone. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';
/** Every free-text field of an activity: the database CHECK forbids more than this. */
const TEXT_MAX = 2000;

/**
 * One lawful basis that points at a processing activity. The link belongs to the basis record (an activity
 * can be justified more than once), so this is what the register reads rather than a field it sets.
 */
export class RopaLawfulBasisDto {
  id!: string;

  @ApiProperty({ enum: LAWFUL_BASES, enumName: 'LawfulBasisKind' })
  basis!: LawfulBasisKind;

  /** What that record says the data is processed for — its own words, not the activity's. */
  purpose!: string;

  @ApiProperty({ enum: LAWFUL_BASIS_REVIEW_STATUSES, enumName: 'LawfulBasisReviewStatus' })
  reviewStatus!: LawfulBasisReviewStatus;
}

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

  /** The basis records that justify this activity, oldest first. An empty list says none has been stated. */
  @ApiProperty({ type: [RopaLawfulBasisDto] })
  lawfulBasisRecords!: RopaLawfulBasisDto[];

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

/** How many activities needing a review one monitor response can carry. */
export const NEEDS_REVIEW_LIST_MAX = 50;

/** How many live activities one business unit holds. */
export class RopaUnitCountDto {
  /** `null` for the group of activities nobody has assigned to a unit. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  businessUnitId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  businessUnitName!: string | null;
  activities!: number;
}

/**
 * One activity whose review is overdue or due soon. A row with no approved due date is `not_reviewed`, so it
 * is an open question rather than a review to chase and never appears here.
 */
export class RopaReviewItemDto {
  id!: string;
  name!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  businessUnitId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  businessUnitName!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  lastReviewDate!: string | null;
  @ApiProperty({ type: String, format: 'date' })
  nextReviewDate!: string;
  /** `overdue` or `due_soon`: the two states that mean somebody should look at it now. */
  @ApiProperty({ enum: REVIEW_STATES, enumName: 'ReviewState' })
  reviewState!: (typeof REVIEW_STATES)[number];
  /** Whole days until the due date (negative = past due). Never null: a listed row has a due date. */
  daysRemaining!: number;
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

  /** Live activities with at least one unarchived lawful basis pointing at them. */
  linkedToLawfulBasis!: number;
  /** Live activities someone has given a classification level. */
  linkedToClassification!: number;
  /** Live activities with neither: the register lists them, but nothing else knows about them. */
  unlinked!: number;

  /** Live activities grouped by business unit, largest group first; the `null` unit is the unassigned one. */
  @ApiProperty({ type: [RopaUnitCountDto] })
  byBusinessUnit!: RopaUnitCountDto[];

  /**
   * The activities needing review, most overdue first, at most `needsReviewLimit` of them. The counts above
   * cover every live row; this list is the part a screen can show.
   */
  @ApiProperty({ type: [RopaReviewItemDto] })
  needsReview!: RopaReviewItemDto[];

  /** How many activities the monitor can hold in one response. */
  needsReviewLimit!: number;

  /** True when more activities need a review than the list below carries. */
  needsReviewTruncated!: boolean;
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

  /**
   * The basis stated as the activity is recorded: a DRAFT lawful-basis record for this purpose, created and
   * linked in the same transaction. Omit it to leave the justification open.
   */
  @ApiPropertyOptional({ enum: LAWFUL_BASES, enumName: 'LawfulBasisKind' })
  @IsOptional()
  @IsIn(LAWFUL_BASES)
  lawfulBasis?: LawfulBasisKind;

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

/**
 * Stating a further basis for an activity that is already on the register: a DRAFT record created for this
 * activity. The purpose defaults to what the activity itself says it processes data for.
 */
export class LinkRopaLawfulBasisDto {
  @ApiProperty({ enum: LAWFUL_BASES, enumName: 'LawfulBasisKind' })
  @IsIn(LAWFUL_BASES)
  basis!: LawfulBasisKind;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(200)
  purpose?: string | null;
}
