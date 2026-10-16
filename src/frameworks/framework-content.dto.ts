import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { TrimText } from '../common/validators/nullable.js';
import { FrameworkDto } from './frameworks.dto.js';

export const FRAMEWORK_VERSION_STATUSES = ['DRAFT', 'VERIFIED', 'PUBLISHED', 'SUPERSEDED'] as const;
export const LICENCE_CLASSES = [
  'PUBLIC_DOMAIN',
  'OPEN_REUSE',
  'LICENSED_TEXT',
  'USER_SUPPLIED',
] as const;
export const TEXT_SOURCES = ['VERBATIM', 'PARAPHRASE', 'REFERENCE_ONLY'] as const;

/**
 * One loaded edition of a framework with its provenance. Only versions that a named person has verified
 * are ever loaded, so a version listed here has a verifier and a verification time.
 */
export class FrameworkVersionDto {
  id!: string;
  /** For example `NIST CSF 2.0`. */
  label!: string;
  @ApiProperty({ enum: FRAMEWORK_VERSION_STATUSES, enumName: 'FrameworkVersionStatus' })
  status!: (typeof FRAMEWORK_VERSION_STATUSES)[number];
  /** How the source may be reused; decides what the platform stores (paid standards: identifiers only). */
  @ApiProperty({ enum: LICENCE_CLASSES, enumName: 'LicenceClass' })
  licenceClass!: (typeof LICENCE_CLASSES)[number];
  /** `YYYY-MM-DD`, when the source states one. */
  effectiveFrom!: string | null;
  /** Where the content was obtained (the primary source). */
  sourceUrl!: string;
  citation!: string;
  /** ISO 8601 UTC instant the source was downloaded. */
  retrievedAt!: string;
  /** Who compared the content with the source. */
  verifiedBy!: string | null;
  /** ISO 8601 UTC instant of that verification: the "last reviewed" date. */
  verifiedAt!: string | null;
  /** `sha256:...` of the stored source file. */
  sourceHash!: string;
  /** `sha256:...` of the requirement and mapping content that was reviewed. */
  contentHash!: string;
  requirementCount!: number;
  /** Cross-framework mappings that come with this version's pack (0 = none: no cited crosswalk exists yet). */
  mappingEntryCount!: number;
}

/** One framework of the catalogue with what is loaded for it. */
export class FrameworkReferenceDto extends FrameworkDto {
  /** The newest verified version, or null: "No verified content yet". */
  currentVersion!: FrameworkVersionDto | null;
  /** Every loaded version, newest first (the current one included). */
  versions!: FrameworkVersionDto[];
}

export class FrameworkReferenceGuideDto {
  items!: FrameworkReferenceDto[];
  /** The wording every mapping surface must carry. */
  disclaimer!: string;
}

export class RequirementDto {
  id!: string;
  /** The framework version it belongs to. */
  versionId!: string;
  /** The parent node of the same version (function > category, chapter > article), if any. */
  parentId!: string | null;
  /** The source's own identifier, for example `GV.OC-01` or `Art. 33`. */
  ref!: string;
  /** `function`, `category`, `subcategory`, `chapter`, `article`, ... */
  kind!: string;
  title!: string;
  description!: string | null;
  /** Whether `title` / `description` are the source's own words (`VERBATIM`), a paraphrase, or just an identifier. */
  @ApiProperty({ enum: TEXT_SOURCES, enumName: 'TextSource' })
  textSource!: (typeof TEXT_SOURCES)[number];
}

export class RequirementPageDto {
  items!: RequirementDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class RequirementListQueryDto extends PageQueryDto {
  /** Only requirements whose identifier or title contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Only the direct children of this requirement. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  /** Only requirements of this kind, for example `subcategory` or `article`. */
  @ApiPropertyOptional({ type: String, maxLength: 40 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(40)
  kind?: string;
}
