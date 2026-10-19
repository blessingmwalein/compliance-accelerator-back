import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { QUADRANTS } from '../domain/prioritisation/eisenhower.js';
import { PageQueryDto } from '../common/pagination.js';
import { OptionalOrNull, TrimText } from '../common/validators/nullable.js';

/** The four Eisenhower quadrants, exactly as the ruleset names them (never re-listed here). */
export const PRIORITY_QUADRANTS = QUADRANTS;
export type QuadrantValue = (typeof QUADRANTS)[number];

/** A list filter may also ask for the items that have NO quadrant because their questionnaire is incomplete. */
export const PRIORITY_QUADRANT_FILTERS = [...QUADRANTS, 'UNCLASSIFIED'] as const;
export type QuadrantFilterValue = (typeof PRIORITY_QUADRANT_FILTERS)[number];

export const PRIORITY_GROUPS = ['URGENCY', 'IMPORTANCE'] as const;
export type PriorityGroupValue = (typeof PRIORITY_GROUPS)[number];

/** The lifecycle an item's assessment can be in; the priority of an item is editable in all four states. */
export const ASSESSMENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED'] as const;
export type AssessmentStatusValue = (typeof ASSESSMENT_STATUSES)[number];

/** `exposure_v1` risk levels, ordered lowest first. */
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevelValue = (typeof RISK_LEVELS)[number];

export const PLAN_WINDOW_SOURCES = ['REFERENCE_DEFAULT', 'ORGANISATION_POLICY'] as const;
export type PlanWindowSourceValue = (typeof PLAN_WINDOW_SOURCES)[number];

/**
 * A flag arrives as a JSON boolean. A client that sends the string form is read for its value: implicit
 * conversion would make `"false"` true, so the raw value is inspected here.
 */
const toFlag = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** One question of the priority questionnaire, in the group that decides one flag. */
export class PriorityQuestionDto {
  /** The key saved in the answers object (for example `manual_handling`). */
  key!: string;
  /** The question as the ruleset words it. Never reworded by a client: saved answers must stay readable. */
  text!: string;
  /** URGENCY decides `urgent`, IMPORTANCE decides `important`. */
  @ApiProperty({ enum: PRIORITY_GROUPS, enumName: 'PriorityQuestionGroup' })
  group!: PriorityGroupValue;
}

/** One question with the answer that is stored for it: the three-state answer scale of the questionnaire. */
export class PriorityAnswerDto extends PriorityQuestionDto {
  /** `true` Yes, `false` No, `null` NOT ANSWERED — which is never the same thing as No. */
  value!: boolean | null;
}

/** A Yes/No/Not-answered choice, for a client that renders the questionnaire itself. */
export class PriorityAnswerOptionDto {
  /** `true` = Yes, `false` = No, `null` = not answered. */
  @ApiProperty({ type: Boolean, nullable: true })
  value!: boolean | null;
  label!: string;
}

/** One point of a 1 to 5 reference scale (labels are the defaults; the stored value is the number). */
export class PriorityScaleOptionDto {
  value!: number;
  label!: string;
}

/** One `exposure_v1` band name with its reference label. */
export class PriorityRiskLevelDto {
  @ApiProperty({ enum: RISK_LEVELS, enumName: 'RiskLevel' })
  key!: RiskLevelValue;
  label!: string;
}

/** Every scale the priority surface displays, so no label is hard-coded in a client. */
export class PriorityScalesDto {
  /** The three-state answer scale of the questionnaire. */
  answers!: PriorityAnswerOptionDto[];
  maturity!: PriorityScaleOptionDto[];
  sensitivity!: PriorityScaleOptionDto[];
  severity!: PriorityScaleOptionDto[];
  likelihood!: PriorityScaleOptionDto[];
  /** The risk-level names an item's exposure is banded into. */
  riskLevels!: PriorityRiskLevelDto[];
}

/** One quadrant: what it means, how it is scheduled and how many items are in it right now. */
export class PriorityQuadrantDto {
  @ApiProperty({ enum: PRIORITY_QUADRANTS, enumName: 'PriorityQuadrant' })
  quadrant!: QuadrantValue;
  label!: string;
  purpose!: string;
  /** The scheduling suggestion of the quadrant, as the ruleset words it. */
  defaultScheduling!: string;
  /** Items whose derived quadrant is this one (counts from the saved answers, never a stored label). */
  count!: number;
}

/** The Plan window: how far ahead work in the PLAN quadrant is scheduled. */
export class PriorityPlanWindowDto {
  minDays!: number;
  maxDays!: number;
  /** `REFERENCE_DEFAULT` when the organisation has set no window; never a silent assumption. */
  @ApiProperty({ enum: PLAN_WINDOW_SOURCES, enumName: 'PlanWindowSource' })
  source!: PlanWindowSourceValue;
}

/** An authorised person's override of a derived flag, always with who, when and why. */
export class PriorityAdjustmentDto {
  /** The override of `urgent`; `null` = this flag is not overridden. */
  @ApiProperty({ type: Boolean, nullable: true })
  urgent!: boolean | null;
  /** The override of `important`; `null` = this flag is not overridden. */
  @ApiProperty({ type: Boolean, nullable: true })
  important!: boolean | null;
  /** The reason the person gave. Required by the database whenever an override is set. */
  reason!: string;
  adjustedByUserId!: string | null;
  adjustedByName!: string | null;
  /** ISO 8601 UTC instant of the adjustment. */
  adjustedAt!: string | null;
}

/** The whole matrix: how the rule reads, what the counts are, and the wording a client must show. */
export class PriorityMatrixDto {
  /** The four quadrants with their counts, in the ruleset order. */
  quadrants!: PriorityQuadrantDto[];
  /**
   * Items the rule cannot place: their questionnaire has no answer that decides both flags (an unanswered
   * question is never read as No). They are counted here, never dropped from the totals.
   */
  unclassified!: number;
  /** Part of `unclassified`: items with no priority row at all, so nobody has opened the questionnaire. */
  withoutQuestionnaire!: number;
  /** Every assessment item considered: `quadrants` counts + `unclassified`. */
  totalItems!: number;
  /** True when the count scan hit its hard limit: the numbers below cover only part of the items. */
  partial!: boolean;
  /** The ruleset version the flags are derived under. */
  rulesetVersion!: number;
  urgencyQuestions!: PriorityQuestionDto[];
  importanceQuestions!: PriorityQuestionDto[];
  scales!: PriorityScalesDto;
  planWindow!: PriorityPlanWindowDto;
  /** Wording every priority surface carries. */
  disclaimer!: string;
}

/** One row of the priority list: the item, what is known about it, and the flags the answers give. */
export class PriorityItemDto {
  assessmentItemId!: string;
  assessmentId!: string;
  assessmentTitle!: string;
  @ApiProperty({ enum: ASSESSMENT_STATUSES, enumName: 'AssessmentStatus' })
  assessmentStatus!: AssessmentStatusValue;
  /** What the item is about, as one line: the area name and the requirement identifier. */
  subject!: string;
  governanceAreaId!: string | null;
  governanceAreaName!: string | null;
  /** True when the area is archived: the item stays in the matrix while its assessment exists. */
  governanceAreaArchived!: boolean;
  requirementId!: string | null;
  requirementRef!: string | null;
  requirementTitle!: string | null;
  businessUnitId!: string | null;
  businessUnitName!: string | null;
  frameworkId!: string | null;
  /** For example `GDPR`. */
  frameworkCode!: string | null;
  ownerMembershipId!: string | null;
  ownerName!: string | null;
  /** Maturity levels short of target; `null` = not assessed on one side, never 0. */
  gap!: number | null;
  /** `exposure_v1` score (sensitivity x severity x likelihood); `null` = not assessed. */
  exposure!: number | null;
  @ApiPropertyOptional({ enum: RISK_LEVELS, enumName: 'RiskLevel', type: String, nullable: true })
  riskLevel!: RiskLevelValue | null;
  /** Remediation tasks raised for this item. */
  taskCount!: number;
  /** True once the item has a priority row (the questionnaire was opened at least once). */
  hasQuestionnaire!: boolean;
  /** True when the questionnaire is fully answered, which is the only way the answers alone give a quadrant. */
  answersComplete!: boolean;
  /** The ruleset version the answers were saved under; `null` before the first save. */
  @ApiProperty({ type: 'integer', nullable: true })
  rulesetVersion!: number | null;
  /** Derived from the answers (with an override taking precedence); `null` = not known. */
  @ApiProperty({ type: Boolean, nullable: true })
  urgent!: boolean | null;
  @ApiProperty({ type: Boolean, nullable: true })
  important!: boolean | null;
  /** `null` = the rule cannot place the item yet: no answer pair and no override that decides both flags. */
  @ApiPropertyOptional({
    enum: PRIORITY_QUADRANTS,
    enumName: 'PriorityQuadrant',
    type: String,
    nullable: true,
  })
  quadrant!: QuadrantValue | null;
  /** The human label of `quadrant`, null when there is no quadrant. */
  quadrantLabel!: string | null;
  /** True when an authorised person's override decided urgency or importance. */
  adjusted!: boolean;
  /** Send it back with the next PUT: a stale value is rejected with 409 `VERSION_CONFLICT`. 1 before the first save. */
  version!: number;
}

/** One page of the list. */
export class PriorityItemPageDto {
  items!: PriorityItemDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

/** Everything the item detail adds to a list row. */
export class ItemPriorityDetailDto extends PriorityItemDto {
  /** The item's own rationale. Read-only here: assessment content is frozen once it leaves DRAFT. */
  rationale!: string | null;
  findings!: string | null;
  currentMaturity!: number | null;
  targetMaturity!: number | null;
  /** All ten questions with the stored answer, so the client can show the criteria behind the quadrant. */
  answers!: PriorityAnswerDto[];
  /** The override in force, or null when both flags follow the answers. */
  @ApiProperty({ type: PriorityAdjustmentDto, nullable: true })
  adjustment!: PriorityAdjustmentDto | null;
  adjustedByUserId!: string | null;
  adjustedByName!: string | null;
  adjustedAt!: string | null;
  /**
   * The reason of the last recorded decision. It survives a withdrawal, so `adjustment` is null while this
   * still tells why the override was set or removed; the answers are not changed by it.
   */
  lastAdjustmentReason!: string | null;
  /** Remediation tasks raised for this item; link them to the source record. */
  taskIds!: string[];
  planWindow!: PriorityPlanWindowDto;
  /** What the ruleset suggests for this quadrant; for PLAN it names the organisation's window. Null without a quadrant. */
  schedulingSuggestion!: string | null;
  /** ISO 8601 UTC instants of the priority row; null before the first save. */
  createdAt!: string | null;
  updatedAt!: string | null;
  disclaimer!: string;
}

/** The full answer set of an item. */
export class SaveItemPriorityDto {
  /**
   * Every question the person answered: `{ question_key: true | false }`. A key sent as `null` or left out
   * means NOT ANSWERED, which is not the same as `false`. Keys outside the ruleset are rejected.
   */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'boolean', nullable: true },
    description: 'The full answer set, keyed by the ruleset question keys.',
  })
  @IsObject()
  answers!: Record<string, boolean | null>;

  /** The `version` of the priority row as last read; 1 when the item has none yet. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** An override of a derived flag, by someone with the approve permission. */
export class AdjustItemPriorityDto {
  /** The new value of `urgent`; omit it to leave the flag alone, send `null` to stop overriding it. */
  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @Transform(toFlag)
  @OptionalOrNull()
  @IsBoolean()
  urgent?: boolean | null;

  /** The new value of `important`; omit it to leave the flag alone, send `null` to stop overriding it. */
  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @Transform(toFlag)
  @OptionalOrNull()
  @IsBoolean()
  important?: boolean | null;

  /** Why the flags change. Required, by the database as well as here. */
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;

  /** The `version` of the priority row as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** Removes both overrides; the answers stay and the flags go back to what they give. */
export class ClearItemPriorityAdjustmentDto {
  /** Why the adjustment is withdrawn. Required. */
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;

  /** The `version` of the priority row as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** Filters of the priority list; the quadrant is derived, so it filters the rows the other filters keep. */
export class PriorityListQueryDto extends PageQueryDto {
  /** Only items in this quadrant, or `UNCLASSIFIED` for the items whose questionnaire is incomplete. */
  @ApiPropertyOptional({
    enum: PRIORITY_QUADRANT_FILTERS,
    enumName: 'PriorityQuadrantFilter',
  })
  @IsOptional()
  @IsIn(PRIORITY_QUADRANT_FILTERS)
  quadrant?: QuadrantFilterValue;

  /** Only items of this business unit of the organisation. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  businessUnitId?: string;

  /** Only items filed under this framework. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  frameworkId?: string;

  /** Only items owned by this member. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ownerMembershipId?: string;

  /** Only items whose assessment is in this state. */
  @ApiPropertyOptional({ enum: ASSESSMENT_STATUSES, enumName: 'AssessmentStatus' })
  @IsOptional()
  @IsIn(ASSESSMENT_STATUSES)
  status?: AssessmentStatusValue;

  /** Only items whose subject (area name or requirement) or findings text contain this (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;
}
