import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
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
