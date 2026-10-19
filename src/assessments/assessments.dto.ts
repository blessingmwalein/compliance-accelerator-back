import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { RISK_LEVELS } from '../domain/scoring/methodologies.js';
import { OptionalOrNull, TrimText, TrimToNull } from '../common/validators/nullable.js';

export const ASSESSMENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED'] as const;
export type AssessmentStatusValue = (typeof ASSESSMENT_STATUSES)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'Use a calendar date in the form YYYY-MM-DD';

export class BandSnapshotDto {
  @ApiProperty({ enum: RISK_LEVELS, enumName: 'RiskLevel' })
  key!: (typeof RISK_LEVELS)[number];
  label!: string;
  /** Inclusive bounds of the score range this band covers. */
  min!: number;
  max!: number;
}

/** The methodology the assessment was scored under, frozen when it was created. */
export class MethodologySnapshotDto {
  /** `exposure_v1`. */
  id!: string;
  version!: number;
  label!: string;
  formula!: string;
}

/** One assessment cycle. Its sign-off and its band snapshot are part of the record, not of today's policy. */
export class AssessmentDto {
  id!: string;
  title!: string;
  description!: string | null;
  @ApiProperty({ enum: ASSESSMENT_STATUSES, enumName: 'AssessmentStatus' })
  status!: AssessmentStatusValue;
  methodology!: MethodologySnapshotDto;
  /** The exposure bands in force when this assessment was created: what its `riskLevel` values mean. */
  @ApiProperty({ type: [BandSnapshotDto] })
  exposureBands!: BandSnapshotDto[];
  createdByUserId!: string;
  submittedAt!: string | null;
  submittedByUserId!: string | null;
  approvedAt!: string | null;
  approvedByUserId!: string | null;
  /** The reviewer's comment on the last return or approval, or the author's note to the reviewer. */
  reviewComment!: string | null;
  /** The approved assessment this one revises (null for a first cycle). */
  revisesAssessmentId!: string | null;
  itemCount!: number;
  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class AssessmentPageDto {
  @ApiProperty({ type: [AssessmentDto] })
  items!: AssessmentDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class AssessmentListQueryDto extends PageQueryDto {
  /** Only assessments in this state (all of them when omitted). */
  @ApiPropertyOptional({ enum: ASSESSMENT_STATUSES, enumName: 'AssessmentStatus' })
  @IsOptional()
  @IsIn(ASSESSMENT_STATUSES)
  status?: AssessmentStatusValue;
}

export class CreateAssessmentDto {
  @TrimText()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title!: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  /** Start this cycle as a revision of an approved or superseded assessment. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  revisesAssessmentId?: string;
}

export class UpdateAssessmentDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title?: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** Body for the actions that only need the version (`revise`). */
export class AssessmentVersionDto {
  @IsInt()
  @Min(1)
  version!: number;
}

/** `DELETE …/assessments/:assessmentId?version=3` — a DELETE carries no body, so the version travels as a query. */
export class AssessmentVersionQueryDto {
  @ApiProperty({ type: Number, minimum: 1, description: 'The version shown by the last read.' })
  @IsInt()
  @Min(1)
  version!: number;
}

/** Submitting for review: the optional note the author leaves for the reviewer. */
export class SubmitAssessmentDto {
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

export class ApproveAssessmentDto {
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** Returning an assessment for more work always says why. */
export class ReturnAssessmentDto {
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  comment!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

/** One cycle of the revision line, with its sign-off. */
export class AssessmentHistoryEntryDto {
  id!: string;
  title!: string;
  @ApiProperty({ enum: ASSESSMENT_STATUSES, enumName: 'AssessmentStatus' })
  status!: AssessmentStatusValue;
  submittedAt!: string | null;
  approvedAt!: string | null;
  /** The person who signed this cycle off (null until it was approved). */
  approvedByUserId!: string | null;
  reviewComment!: string | null;
  /** True for the assessment this request is about. */
  current!: boolean;
}

export class AssessmentHistoryDto {
  /** The cycle this one came from, if any. */
  revisesAssessmentId!: string | null;
  @ApiProperty({ type: [AssessmentHistoryEntryDto] })
  entries!: AssessmentHistoryEntryDto[];
}

/** A value with the coverage it is based on: unassessed items are dropped, never counted as zero. */
export class MeasuredDto {
  /** Null when nothing was assessed. */
  value!: number | null;
  assessed!: number;
  applicable!: number;
}

/** The roll-up of an assessment's items (AC-GOV-03), with the same filters the table offers. */
export class AssessmentSummaryDto {
  assessmentId!: string;
  @ApiProperty({ enum: ASSESSMENT_STATUSES, enumName: 'AssessmentStatus' })
  status!: AssessmentStatusValue;
  /** Items the filters left in the set. */
  itemCount!: number;
  averageMaturity!: MeasuredDto;
  averageGap!: MeasuredDto;
  averageExposure!: MeasuredDto;
  /** Items rated High or Critical; null when none is rated. */
  highOrCritical!: MeasuredDto;
  byRiskLevel!: Record<(typeof RISK_LEVELS)[number], number>;
  /** Items with no exposure rating yet. */
  notRated!: number;
  /** Scores are informative aids, not legal advice. */
  disclaimer!: string;
}

/** Filters for the summary, table and items list: AC-GOV-05. */
export class ItemFilterQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  businessUnitId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  frameworkId?: string;
}

/** One assessed subject: what was rated, what came of it, and who owns it. */
export class AssessmentItemDto {
  id!: string;
  assessmentId!: string;
  governanceAreaId!: string | null;
  governanceAreaName!: string | null;
  /** A requirement of a verified framework version (null when the item is a governance area only). */
  requirementId!: string | null;
  requirementRef!: string | null;
  frameworkId!: string | null;
  frameworkCode!: string | null;
  /** Null = the whole organisation (shown as such, never a magic value). */
  businessUnitId!: string | null;
  businessUnitName!: string | null;
  /** Null means NOT ASSESSED: never 0, never a default. */
  currentMaturity!: number | null;
  targetMaturity!: number | null;
  sensitivity!: number | null;
  severity!: number | null;
  likelihood!: number | null;
  /** Derived server-side: target minus current, null when either side is unassessed. */
  gap!: number | null;
  /** Derived server-side: sensitivity x severity x likelihood, null when any factor is unassessed. */
  exposure!: number | null;
  /** Derived from `exposure` and the assessment's band snapshot; null when there is no score. */
  riskLevel!: (typeof RISK_LEVELS)[number] | null;
  rationale!: string | null;
  findings!: string | null;
  ownerMembershipId!: string | null;
  ownerName!: string | null;
  /** Date-only (`YYYY-MM-DD`), evaluated in the organisation's timezone. */
  lastReviewDate!: string | null;
  nextReviewDate!: string | null;
  /** Evidence files attached to this item. */
  @ApiProperty({ type: [String] })
  evidenceIds!: string[];
  version!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class AssessmentItemPageDto {
  @ApiProperty({ type: [AssessmentItemDto] })
  items!: AssessmentItemDto[];
  nextCursor!: string | null;
}

export class AssessmentItemListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  businessUnitId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  frameworkId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  governanceAreaId?: string;

  /** Only items that carry at least one rating (the rest are "not started"). */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  ratedOnly?: boolean;
}

/** The subject of an item: at least one of `governanceAreaId` and `requirementId` is needed. */
export class CreateAssessmentItemDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  governanceAreaId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  requirementId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsString()
  businessUnitId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsString()
  frameworkId?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 5, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  currentMaturity?: number | null;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 5, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  targetMaturity?: number | null;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 5, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  sensitivity?: number | null;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 5, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  severity?: number | null;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 5, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(5)
  likelihood?: number | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(4000)
  rationale?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(4000)
  findings?: string | null;

  /** The member accountable for this subject: an ACTIVE membership of this organisation. */
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsString()
  ownerMembershipId?: string | null;

  @ApiPropertyOptional({ type: String, pattern: '\\d{4}-\\d{2}-\\d{2}', nullable: true })
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  lastReviewDate?: string | null;

  @ApiPropertyOptional({ type: String, pattern: '\\d{4}-\\d{2}-\\d{2}', nullable: true })
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  nextReviewDate?: string | null;
}

/**
 * Omit a field to keep it; `null` on a rating means "not assessed" again, and `null` on `businessUnitId` or
 * `ownerMembershipId` returns the item to the whole organisation / to no named owner. What an item is ABOUT
 * cannot be cleared: `governanceAreaId` and `requirementId` are optional to send but a sent `null` is refused.
 */
export class UpdateAssessmentItemDto extends CreateAssessmentItemDto {
  @IsInt()
  @Min(1)
  version!: number;
}

/** `POST …/assessments/:assessmentId/items/from-template` (AC-GOV-01). */
export class ApplyTemplateDto {
  /** The id of a published template edition. */
  @ApiProperty({ type: String, format: 'uuid' })
  templateId!: string;
}

export class ApplyTemplateResultDto {
  /** New items the template created, in the template's own order. */
  @ApiProperty({ type: [AssessmentItemDto] })
  items!: AssessmentItemDto[];
  inserted!: number;
  /** Subjects the assessment already had: applying a template twice never duplicates. */
  skipped!: number;
  /** Governance areas the organisation did not have and this created. */
  @ApiProperty({ type: [String] })
  createdAreaNames!: string[];
  disclaimer!: string;
}

/** `POST …/assessment-items/:itemId/evidence`. */
export class LinkEvidenceDto {
  @ApiProperty({ type: String, format: 'uuid' })
  evidenceId!: string;
}

/** The item's links after a link or an unlink, so the frontend never has to refetch. */
export class ItemEvidenceDto {
  itemId!: string;
  @ApiProperty({ type: [String] })
  evidenceIds!: string[];
}
