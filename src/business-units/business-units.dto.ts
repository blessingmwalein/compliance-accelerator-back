import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
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

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,19}$/;
const CODE_MESSAGE = 'code may contain letters, digits, spaces, - and _ (up to 20)';

export class BusinessUnitDto {
  id!: string;
  name!: string;
  /** Short identifier chosen by the organisation (for example "FIN"), if any. Unique per organisation. */
  code!: string | null;
  description!: string | null;
  /** The membership id of the member who heads the unit, if set. */
  headMembershipId!: string | null;
  /** The head's display name (null when no head is set). */
  headName!: string | null;
  /** Data sensitivity classification, 1 (Public) to 5 (Critical). Null = not classified; never a default. */
  sensitivity!: number | null;
  /** Number of employees, if known. Null = not provided (not zero). */
  employeeCount!: number | null;
  parentId!: string | null;
  parentName!: string | null;
  /** True once archived: hidden from pickers, kept for history. */
  archived!: boolean;
  /** ISO 8601 UTC instant, when archived. */
  archivedAt!: string | null;
  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

export class BusinessUnitPageDto {
  items!: BusinessUnitDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class BusinessUnitListQueryDto extends PageQueryDto {
  /** Include archived units (they are hidden by default). */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  includeArchived?: boolean;

  /** Only units whose name or code contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;
}

export class CreateBusinessUnitDto {
  /** Unique among the organisation's active units (case-insensitive). */
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Optional short identifier, unique in the organisation (letters, digits, space, - and _, up to 20). */
  @TrimToNull()
  @OptionalOrNull()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  /** The membership id of an ACTIVE member who heads the unit. */
  @OptionalOrNull()
  @IsUUID()
  headMembershipId?: string | null;

  /** 1 (Public) to 5 (Critical). Omit or send null for "not classified". */
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  sensitivity?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  employeeCount?: number | null;

  /** An active business unit of the same organisation. */
  @OptionalOrNull()
  @IsUUID()
  parentId?: string | null;
}

export class UpdateBusinessUnitDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @TrimToNull()
  @OptionalOrNull()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @OptionalOrNull()
  @IsUUID()
  headMembershipId?: string | null;

  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  sensitivity?: number | null;

  @OptionalOrNull()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  employeeCount?: number | null;

  @OptionalOrNull()
  @IsUUID()
  parentId?: string | null;

  /** The `version` of the unit as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class BusinessUnitVersionDto {
  /** The `version` of the unit as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}
