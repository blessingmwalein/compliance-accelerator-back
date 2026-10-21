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
  CLASSIFICATION_TIERS,
  DATA_POSTURES,
  type ClassificationTier,
  type DataPosture,
} from '../domain/registers/records.js';

/** A calendar date (`YYYY-MM-DD`): stored in a DATE column, judged in the organisation's time zone. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';

const toBoolean = ({ value }: { value: unknown }) =>
  // class-transformer's implicit conversion turns "false" into true, so the raw value is read here.
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

/**
 * One level of the organisation's data classification scheme (Public, Internal, Confidential…). The
 * scheme is the organisation's own: nothing is seeded, and an organisation with no levels is
 * `not_configured` rather than "everything is Internal".
 */
export class ClassificationLevelDto {
  id!: string;
  name!: string;

  /** The position in the scheme, lowest sensitivity first. Unique per organisation, archived included. */
  rank!: number;

  description!: string | null;

  /** How data at this level is to be handled (encryption, sharing, marking). Free text, never legal advice. */
  handlingGuidance!: string | null;

  /**
   * The reference tier this level is graded at, or null when nobody tagged it. The organisation's own word
   * for the level stays in `name`; the tier is the fixed vocabulary the register filters and counts on.
   */
  @ApiProperty({ enum: CLASSIFICATION_TIERS, enumName: 'ClassificationTier', nullable: true })
  tier!: ClassificationTier | null;

  /**
   * How exposed data at this level is, as the organisation states it. Never derived from the tier, and
   * never inferred when it is absent.
   */
  @ApiProperty({ enum: DATA_POSTURES, enumName: 'DataPosture', nullable: true })
  posture!: DataPosture | null;

  /** How long data at this level is kept, in words. The rule itself lives in the retention register. */
  retentionPeriod!: string | null;

  /** A control stated for this level by the organisation, not one the platform has verified. */
  encryptionRequired!: boolean;

  /** The membership id of the member who owns this level, if set. */
  ownerMembershipId!: string | null;

  /** The owner's display name (null when none is set). */
  ownerName!: string | null;

  /** The day the level was last reviewed (`YYYY-MM-DD`), or null when it never has been. */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  lastReviewDate!: string | null;

  /** The day the next review is due (`YYYY-MM-DD`), or null when no date was approved. */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextReviewDate!: string | null;

  /** True once archived: hidden from pickers, kept for history. */
  archived!: boolean;

  /** ISO 8601 UTC instant, when archived. */
  archivedAt!: string | null;

  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

export class ClassificationLevelPageDto {
  items!: ClassificationLevelDto[];

  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class ClassificationLevelListQueryDto extends PageQueryDto {
  /** Include archived levels (they are hidden by default). */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;

  /** Only levels whose name or description contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Only levels tagged at this reference tier. Untagged levels match no tier. */
  @ApiPropertyOptional({ enum: CLASSIFICATION_TIERS, enumName: 'ClassificationTier' })
  @IsOptional()
  @IsIn(CLASSIFICATION_TIERS)
  tier?: ClassificationTier;
}

/**
 * How much of the scheme the reference app's four cards ask about, counted over every live level rather
 * than over one page of the list.
 */
export class ClassificationSummaryDto {
  /** `no_scheme`: the organisation has no levels at all. `ok`: the counts below are real. */
  @ApiProperty({
    enum: ['ok', 'no_scheme'],
    enumName: 'ClassificationSummaryAvailability',
  })
  availability!: 'ok' | 'no_scheme';

  /** Today in the organisation's time zone: the day the counts were decided against. */
  asOf!: string;

  /** Live (non-archived) levels in the scheme. */
  total!: number;
  /** Live levels tagged RESTRICTED. A level nobody tagged counts towards none of the tiers. */
  restricted!: number;
  confidential!: number;
  /** Live levels whose stated posture is HIGH or CRITICAL. */
  highExposure!: number;
}

export class CreateClassificationLevelDto {
  /** Unique among the organisation's active levels (case-insensitive). */
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  /**
   * Where the level sits in the scheme (1 = least sensitive). Omit to append it at the end; archived levels
   * keep their rank, so a rank that was used once is never handed out again.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  rank?: number;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  handlingGuidance?: string | null;

  /** The reference tier to grade this level at. Omit to leave it untagged. */
  @ApiPropertyOptional({ enum: CLASSIFICATION_TIERS, enumName: 'ClassificationTier' })
  @IsOptional()
  @IsIn(CLASSIFICATION_TIERS)
  tier?: ClassificationTier;

  /** How exposed data at this level is. Omit to leave the posture unstated. */
  @ApiPropertyOptional({ enum: DATA_POSTURES, enumName: 'DataPosture' })
  @IsOptional()
  @IsIn(DATA_POSTURES)
  posture?: DataPosture;

  /** How long data at this level is kept, in words. */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  retentionPeriod?: string | null;

  /** Default false: a level nobody has assessed does not claim that encryption is required at it. */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  encryptionRequired?: boolean;

  /** The membership id of an ACTIVE member who owns the level. */
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

export class UpdateClassificationLevelDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  rank?: number;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  handlingGuidance?: string | null;

  /** The reference tier to grade this level at. `null` clears the tag: the level goes back to untagged. */
  @ApiPropertyOptional({
    enum: CLASSIFICATION_TIERS,
    enumName: 'ClassificationTier',
    nullable: true,
  })
  @OptionalOrNull()
  @IsIn(CLASSIFICATION_TIERS)
  tier?: ClassificationTier | null;

  /** How exposed data at this level is. `null` leaves the posture unstated again. */
  @ApiPropertyOptional({ enum: DATA_POSTURES, enumName: 'DataPosture', nullable: true })
  @OptionalOrNull()
  @IsIn(DATA_POSTURES)
  posture?: DataPosture | null;

  /** How long data at this level is kept, in words. */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  retentionPeriod?: string | null;

  /** Default false: a level nobody has assessed does not claim that encryption is required at it. */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  encryptionRequired?: boolean;

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

  /** The `version` of the level as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class ClassificationLevelVersionDto {
  /** The `version` of the level as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}
