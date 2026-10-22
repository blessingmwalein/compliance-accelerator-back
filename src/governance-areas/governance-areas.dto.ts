import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { OptionalOrNull, TrimText, TrimToNull } from '../common/validators/nullable.js';

export class GovernanceAreaDto {
  id!: string;
  /** Unique among the organisation's active areas (case-insensitive). */
  name!: string;
  description!: string | null;
  /**
   * The organisation's own short label for this row, shown beside its name. A label it chose: the platform
   * ships no taxonomy, so null is "nobody has labelled it", never a category guessed from the name.
   */
  category!: string | null;
  /** What the organisation says it achieves on this topic, in its own words. Never a control verdict. */
  controlObjective!: string | null;
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

/**
 * One cell of the mapping row: the organisation's own reference text for this governance area in one
 * framework of the catalogue. It is a statement the organisation makes, not a mapping — the verified links
 * between requirements live on `compliance-mappings` and are unaffected by it.
 */
export class MappingNoteInputDto {
  /** A framework of the catalogue. An unknown or retired id is refused with `VALIDATION_FAILED`. */
  @IsUUID('all')
  frameworkId!: string;

  /** The cell's text (up to 500 characters). Null or blank clears the cell. */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  note?: string | null;
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

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(80)
  category?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  controlObjective?: string | null;

  /** The row's own reference text per framework. Omit it to store none; a duplicate framework is refused. */
  @ApiPropertyOptional({ type: [MappingNoteInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ArrayUnique((note: MappingNoteInputDto) => note.frameworkId)
  @ValidateNested({ each: true })
  @Type(() => MappingNoteInputDto)
  notes?: MappingNoteInputDto[];
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

  /** Omit to keep it; send null or blank to clear the label. */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(80)
  category?: string | null;

  /** Omit to keep it; send null or blank to clear the objective. */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  controlObjective?: string | null;

  /**
   * The whole desired set of the row's reference notes: a framework absent from the list has its cell
   * cleared, and omitting the key leaves every cell as it is.
   */
  @ApiPropertyOptional({ type: [MappingNoteInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ArrayUnique((note: MappingNoteInputDto) => note.frameworkId)
  @ValidateNested({ each: true })
  @Type(() => MappingNoteInputDto)
  notes?: MappingNoteInputDto[];

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
