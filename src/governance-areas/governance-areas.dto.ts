import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { OptionalOrNull, TrimText, TrimToNull } from '../common/validators/nullable.js';

export class GovernanceAreaDto {
  id!: string;
  /** Unique among the organisation's active areas (case-insensitive). */
  name!: string;
  description!: string | null;
  /** True once archived: hidden from pickers, kept for history. */
  archived!: boolean;
  /** ISO 8601 UTC instant, when archived. */
  archivedAt!: string | null;
  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

export class GovernanceAreaPageDto {
  items!: GovernanceAreaDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class GovernanceAreaListQueryDto extends PageQueryDto {
  /** Include archived areas (they are hidden by default). */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  includeArchived?: boolean;

  /** Only areas whose name contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;
}

export class CreateGovernanceAreaDto {
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

export class UpdateGovernanceAreaDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  /** The `version` of the area as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class GovernanceAreaVersionDto {
  /** The `version` of the area as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}
