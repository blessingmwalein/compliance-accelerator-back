import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { OptionalOrNull, TrimText, TrimToNull } from '../common/validators/nullable.js';

export const MAPPING_RELATIONSHIPS = ['EXACT', 'PARTIAL', 'RELATED'] as const;
export const MAPPING_ORIGINS = ['SEED', 'USER'] as const;
export const MAPPING_REVIEW_STATUSES = ['DRAFT', 'UNDER_REVIEW', 'APPROVED'] as const;
export type MappingRelationshipValue = (typeof MAPPING_RELATIONSHIPS)[number];
export type MappingReviewStatusValue = (typeof MAPPING_REVIEW_STATUSES)[number];

const toBoolean = ({ value }: { value: unknown }) => value === 'true' || value === true;

/** A framework requirement as shown in a mapping: its identifier, title and the framework version it belongs to. */
export class MappingRequirementDto {
  id!: string;
  /** The source's own identifier, for example `GV.OC-01` or `Art. 33`. */
  ref!: string;
  title!: string;
  kind!: string;
  versionId!: string;
  versionLabel!: string;
  frameworkId!: string;
  /** For example `GDPR`. */
  frameworkCode!: string;
}

export class OrganisationMappingDto {
  id!: string;
  /** The governance area the mapping is filed under, if any. */
  areaId!: string | null;
  areaName!: string | null;
  from!: MappingRequirementDto;
  to!: MappingRequirementDto;
  /** How closely the two requirements align. Informative only: never a statement of legal equivalence. */
  @ApiProperty({ enum: MAPPING_RELATIONSHIPS, enumName: 'MappingRelationship' })
  relationship!: MappingRelationshipValue;
  /** `SEED`: copied from a verified default pack. `USER`: made by a person of this organisation. */
  @ApiProperty({ enum: MAPPING_ORIGINS, enumName: 'MappingOrigin' })
  origin!: (typeof MAPPING_ORIGINS)[number];
  /** Why the two are mapped. Mandatory for a user mapping; a seeded mapping carries its pack citation. */
  rationale!: string | null;
  /** A citation or link supporting the mapping. */
  reference!: string | null;
  @ApiProperty({ enum: MAPPING_REVIEW_STATUSES, enumName: 'MappingReviewStatus' })
  reviewStatus!: MappingReviewStatusValue;
  archived!: boolean;
  archivedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

export class MappingPageDto {
  items!: OrganisationMappingDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class MappingListQueryDto extends PageQueryDto {
  /** Only mappings whose requirement identifiers or titles contain this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  /** Only mappings that involve a requirement of this framework (either side). */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  frameworkId?: string;

  @ApiPropertyOptional({ enum: MAPPING_RELATIONSHIPS, enumName: 'MappingRelationship' })
  @IsOptional()
  @IsIn(MAPPING_RELATIONSHIPS)
  relationship?: MappingRelationshipValue;

  @ApiPropertyOptional({ enum: MAPPING_REVIEW_STATUSES, enumName: 'MappingReviewStatus' })
  @IsOptional()
  @IsIn(MAPPING_REVIEW_STATUSES)
  reviewStatus?: MappingReviewStatusValue;

  /** Include archived mappings (they are hidden by default). */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

export class CreateMappingDto {
  /** An active governance area of this organisation. Omit or send null to leave the mapping unfiled. */
  @OptionalOrNull()
  @IsUUID()
  areaId?: string | null;

  /** The source requirement (a requirement of a loaded, verified framework version). */
  @IsUUID()
  fromRequirementId!: string;

  /** The target requirement: it must belong to a DIFFERENT framework than the source. */
  @IsUUID()
  toRequirementId!: string;

  @ApiProperty({ enum: MAPPING_RELATIONSHIPS, enumName: 'MappingRelationship' })
  @IsIn(MAPPING_RELATIONSHIPS)
  relationship!: MappingRelationshipValue;

  /** Why the two are mapped (required, up to 1000 characters). */
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  rationale!: string;

  /** A citation or link supporting the mapping (up to 300 characters). */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(300)
  reference?: string | null;

  /** Defaults to `DRAFT`. */
  @ApiPropertyOptional({ enum: MAPPING_REVIEW_STATUSES, enumName: 'MappingReviewStatus' })
  @IsOptional()
  @IsIn(MAPPING_REVIEW_STATUSES)
  reviewStatus?: MappingReviewStatusValue;
}

/**
 * Omit a field to keep it. A mapping that came from the default pack (`origin` SEED) can only change its
 * area and review status; its requirements, relationship, rationale and reference are fixed.
 */
export class UpdateMappingDto {
  @OptionalOrNull()
  @IsUUID()
  areaId?: string | null;

  @IsOptional()
  @IsUUID()
  fromRequirementId?: string;

  @IsOptional()
  @IsUUID()
  toRequirementId?: string;

  @ApiPropertyOptional({ enum: MAPPING_RELATIONSHIPS, enumName: 'MappingRelationship' })
  @IsOptional()
  @IsIn(MAPPING_RELATIONSHIPS)
  relationship?: MappingRelationshipValue;

  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  rationale?: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(300)
  reference?: string | null;

  @ApiPropertyOptional({ enum: MAPPING_REVIEW_STATUSES, enumName: 'MappingReviewStatus' })
  @IsOptional()
  @IsIn(MAPPING_REVIEW_STATUSES)
  reviewStatus?: MappingReviewStatusValue;

  /** The `version` of the mapping as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class MappingVersionDto {
  /** The `version` of the mapping as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

export class MappingMatrixQueryDto extends PageQueryDto {
  /** Only governance areas whose name contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Show only mappings with this relationship; areas without one are left out. */
  @ApiPropertyOptional({ enum: MAPPING_RELATIONSHIPS, enumName: 'MappingRelationship' })
  @IsOptional()
  @IsIn(MAPPING_RELATIONSHIPS)
  relationship?: MappingRelationshipValue;

  /** Show only mappings with this review status; areas without one are left out. */
  @ApiPropertyOptional({ enum: MAPPING_REVIEW_STATUSES, enumName: 'MappingReviewStatus' })
  @IsOptional()
  @IsIn(MAPPING_REVIEW_STATUSES)
  reviewStatus?: MappingReviewStatusValue;

  /** Include archived mappings (they are hidden by default). */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

/** One side of a mapping, placed in the column of its framework. */
export class MatrixEntryDto {
  mappingId!: string;
  frameworkId!: string;
  /** The column this entry belongs in. */
  frameworkCode!: string;
  requirementId!: string;
  ref!: string;
  title!: string;
  /** The framework and identifier on the other side of the mapping. */
  counterpartFrameworkCode!: string;
  counterpartRef!: string;
  @ApiProperty({ enum: MAPPING_RELATIONSHIPS, enumName: 'MappingRelationship' })
  relationship!: MappingRelationshipValue;
  @ApiProperty({ enum: MAPPING_REVIEW_STATUSES, enumName: 'MappingReviewStatus' })
  reviewStatus!: MappingReviewStatusValue;
  @ApiProperty({ enum: MAPPING_ORIGINS, enumName: 'MappingOrigin' })
  origin!: (typeof MAPPING_ORIGINS)[number];
  archived!: boolean;
}

/**
 * One reference cell of a row: what this organisation states on the topic of that area in one framework.
 * Free text the organisation typed itself, next to the verified requirement links of the same cell — it
 * explains a position, it never claims a mapping.
 */
export class MatrixNoteDto {
  frameworkId!: string;
  /** The column this cell belongs in. */
  frameworkCode!: string;
  note!: string;
  /** When the cell was last written, as an ISO timestamp. */
  updatedAt!: string;
}

/** One row of the mapping table: a governance area (or the mappings that are not filed under one). */
export class MatrixRowDto {
  /** Null for the row of mappings that are not filed under an area. */
  areaId!: string | null;
  areaName!: string | null;
  areaDescription!: string | null;
  /** The area's own category label, or null when nobody has stated one. */
  areaCategory!: string | null;
  /** The area's own control objective, or null. */
  areaControlObjective!: string | null;
  /** True for an archived area that still holds mappings: it stays visible until they are archived or moved. */
  areaArchived!: boolean;
  /** Every entry of the area's mappings; the client places each in the column of its `frameworkCode`. */
  entries!: MatrixEntryDto[];
  /** The area's reference cells, ordered by framework. Empty for the row of unfiled mappings. */
  notes!: MatrixNoteDto[];
}

export class MappingMatrixDto {
  rows!: MatrixRowDto[];
  /** Pass as `after` to get the next page of areas; null on the last page. */
  nextCursor!: string | null;
  /** The wording every mapping surface carries. */
  disclaimer!: string;
}

export class LoadDefaultsFailureDto {
  /** The pack entry that could not be copied. */
  sourceEntryId!: string;
  reason!: string;
}

export class LoadDefaultsResultDto {
  /** Mappings copied into the organisation by this run. */
  inserted!: number;
  /** Pack entries the organisation already has (copied earlier, or the same pair mapped by hand): left untouched. */
  skipped!: number;
  failed!: LoadDefaultsFailureDto[];
  /** The codes of the applicable frameworks that were considered. */
  frameworks!: string[];
}
