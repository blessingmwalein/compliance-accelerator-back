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
  LAWFUL_BASES,
  LAWFUL_BASIS_REVIEW_STATUSES,
  type LawfulBasisKind,
  type LawfulBasisReviewStatus,
} from '../domain/registers/records.js';
import { REVIEW_STATES, type ReviewState } from '../domain/registers/review.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';
/** The justification is the argument, and an argument can be long; the database CHECK forbids more. */
const JUSTIFICATION_MAX = 4000;

const toBoolean = ({ value }: { value: unknown }) =>
  // class-transformer's implicit conversion turns "false" into true, so the raw value is read here.
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

/**
 * One lawful basis for one purpose: why the organisation may process this personal data at all. A record
 * is only an assertion until somebody APPROVES it, and an approval always comes with the reasoning that
 * supports it — never with a default.
 */
export class LawfulBasisRecordDto {
  id!: string;

  /** What the data is processed for. This, not the activity, is what the basis justifies. */
  purpose!: string;

  @ApiProperty({ enum: LAWFUL_BASES, enumName: 'LawfulBasisKind' })
  basis!: LawfulBasisKind;

  /** The framework the obligation comes from, when it comes from one. */
  frameworkId!: string | null;
  frameworkCode!: string | null;

  requirementId!: string | null;
  requirementRef!: string | null;
  requirementTitle!: string | null;

  /** The processing activity this justifies (an activity can have more than one basis). */
  processingActivityId!: string | null;
  processingActivityName!: string | null;

  /** Why this is the right basis, in the organisation's own words. Required by an approval. */
  justification!: string | null;

  @ApiProperty({ enum: LAWFUL_BASIS_REVIEW_STATUSES, enumName: 'LawfulBasisReviewStatus' })
  reviewStatus!: LawfulBasisReviewStatus;

  ownerMembershipId!: string | null;
  ownerName!: string | null;

  reviewIntervalDays!: number | null;
  reviewLeadDays!: number | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  lastReviewDate!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextReviewDate!: string | null;

  @ApiProperty({ enum: REVIEW_STATES, enumName: 'ReviewState' })
  reviewState!: ReviewState;

  daysRemaining!: number | null;

  archived!: boolean;
  archivedAt!: string | null;

  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

/** The detail adds the evidence linked to this record. */
export class LawfulBasisRecordDetailDto extends LawfulBasisRecordDto {
  /** Evidence ids, oldest link first. */
  evidenceIds!: string[];
}

export class LawfulBasisRecordPageDto {
  items!: LawfulBasisRecordDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class ListLawfulBasisQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: LAWFUL_BASES, enumName: 'LawfulBasisKind' })
  @IsOptional()
  @IsIn(LAWFUL_BASES)
  basis?: LawfulBasisKind;

  @ApiPropertyOptional({
    enum: LAWFUL_BASIS_REVIEW_STATUSES,
    enumName: 'LawfulBasisReviewStatus',
  })
  @IsOptional()
  @IsIn(LAWFUL_BASIS_REVIEW_STATUSES)
  reviewStatus?: LawfulBasisReviewStatus;

  /** Only records justifying this processing activity. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  processingActivityId?: string;

  /** Include archived records (they are hidden by default). */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;

  /** Only records whose purpose or justification contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;
}

export class CreateLawfulBasisRecordDto {
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  purpose!: string;

  @ApiProperty({ enum: LAWFUL_BASES, enumName: 'LawfulBasisKind' })
  @IsIn(LAWFUL_BASES)
  basis!: LawfulBasisKind;

  /** A framework this obligation comes from. */
  @OptionalOrNull()
  @IsUUID()
  frameworkId?: string | null;

  /** A verified requirement this basis answers. */
  @OptionalOrNull()
  @IsUUID()
  requirementId?: string | null;

  /** An ACTIVE processing activity of this organisation. */
  @OptionalOrNull()
  @IsUUID()
  processingActivityId?: string | null;

  /** Why this basis is the right one. A new record starts as DRAFT, so it is not required yet. */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(JUSTIFICATION_MAX)
  justification?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

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

/**
 * What a person may change. `reviewStatus` is NOT one of them: an approval is a decision with its own
 * endpoint, its own permission, and its own audit entry.
 */
export class UpdateLawfulBasisRecordDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  purpose?: string;

  @ApiPropertyOptional({ enum: LAWFUL_BASES, enumName: 'LawfulBasisKind' })
  @IsOptional()
  @IsIn(LAWFUL_BASES)
  basis?: LawfulBasisKind;

  @OptionalOrNull()
  @IsUUID()
  frameworkId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  requirementId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  processingActivityId?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(JUSTIFICATION_MAX)
  justification?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

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

  /** The `version` of the record as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * The decision about a basis: taking it into review, approving it, or taking an approval back.
 * Approving needs the justification it approves; withdrawing an approval needs a reason.
 */
export class ReviewLawfulBasisRecordDto {
  @ApiProperty({ enum: LAWFUL_BASIS_REVIEW_STATUSES, enumName: 'LawfulBasisReviewStatus' })
  @IsIn(LAWFUL_BASIS_REVIEW_STATUSES)
  toStatus!: LawfulBasisReviewStatus;

  /** The reasoning behind an approval. Sent here it is stored; otherwise the record's own text is used. */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(JUSTIFICATION_MAX)
  justification?: string | null;

  /** The new due date to set when the review is done. Omit to leave the register with no due date. */
  @TrimToNull()
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  nextReviewDate?: string | null;

  /** Why an approval is being taken back (required to move away from APPROVED). */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason?: string | null;

  /** The `version` of the record as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class LawfulBasisRecordVersionDto {
  /** The `version` of the record as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** Linking an evidence file to a basis record: the file itself is uploaded through the evidence endpoints. */
export class LinkLawfulBasisEvidenceDto {
  @IsUUID()
  evidenceId!: string;
}
