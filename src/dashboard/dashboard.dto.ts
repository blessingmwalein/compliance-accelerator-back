import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { BandSnapshotDto, MeasuredDto } from '../assessments/assessments.dto.js';
import { TASK_PRIORITIES, TASK_STATUSES } from '../domain/remediation/policy.js';
import { RISK_CATEGORIES, RISK_STATUSES } from '../domain/risk/policy.js';
import { RISK_LEVELS, type RiskLevel } from '../domain/scoring/methodologies.js';

/** The two factor pairs a risk can be ranked or plotted on. The heat map and the top list share the word. */
const BASIS_VALUES = ['residual', 'inherent'] as const;
type BasisValue = (typeof BASIS_VALUES)[number];

/** The verdict word of a measured dashboard figure; `compliant` is shown as "Meets target", never as a legal claim. */
export const DASHBOARD_STATUSES = ['compliant', 'needs_attention', 'in_progress'] as const;
export type DashboardStatusValue = (typeof DASHBOARD_STATUSES)[number];

/** The scoring methodology one set of subjects was rated under. */
export class MethodologyRefDto {
  /** `exposure_v1` for every cycle built so far. */
  id!: string;
  version!: number;
}

/** Current, target and gap of one set of assessed subjects. */
export class MaturityMetricDto {
  /**
   * `not_assessed`: nothing in the organisation's current answers carries a maturity level. An unassessed
   * register is never a zero and never a verdict.
   */
  @ApiProperty({ enum: ['ok', 'not_assessed'], enumName: 'MaturityMetricAvailability' })
  availability!: 'ok' | 'not_assessed';
  /** Mean `currentMaturity` over the subjects that carry one. */
  current!: MeasuredDto;
  /** Mean `targetMaturity` over the subjects that carry one. */
  target!: MeasuredDto;
  /** Mean gap (target minus current, never below zero) over the subjects that have both sides. */
  gap!: MeasuredDto;
  /** The subjects in the set: the denominator every coverage pair above is taken against. */
  applicable!: number;
  @ApiProperty({ enum: DASHBOARD_STATUSES, nullable: true })
  status!: DashboardStatusValue | null;
}

/** The organisation's exposure position, and why it may decline to state one. */
export class ExposureMetricDto {
  /**
   * `no_records`: no submitted or approved cycle yet. `not_assessed`: subjects exist, none is rated.
   * `unable_to_calculate`: the counted cycles were scored under more than one methodology, and two band
   * sets do not make one average — `methodologies` names them.
   */
  @ApiProperty({
    enum: ['ok', 'no_records', 'not_assessed', 'unable_to_calculate'],
    enumName: 'ExposureMetricAvailability',
  })
  availability!: 'ok' | 'no_records' | 'not_assessed' | 'unable_to_calculate';
  @ApiProperty({ type: [MethodologyRefDto] })
  methodologies!: MethodologyRefDto[];
  mean!: MeasuredDto;
  /** The band the mean falls in, under the organisation's bands in force today; null when there is no mean. */
  @ApiProperty({ type: BandSnapshotDto, nullable: true })
  band!: BandSnapshotDto | null;
  /** Subjects per band; null when the methodologies above differ, because the bands would not mean one thing. */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    nullable: true,
  })
  byRiskLevel!: Record<RiskLevel, number> | null;
  @ApiProperty({ enum: DASHBOARD_STATUSES, nullable: true })
  status!: DashboardStatusValue | null;
}

/** One getting-started step: what it asks for, and whether the saved data already answers it. */
export class GettingStartedStepDto {
  @ApiProperty({
    enum: [
      'companyDetails',
      'businessUnits',
      'submittedAssessment',
      'ropaRecords',
      'classifiedData',
      'mappingReviewed',
    ],
    enumName: 'GettingStartedStepKey',
  })
  key!: GettingStartedStepKey;
  title!: string;
  description!: string;
  /** Derived from saved records on every read: there is no "step done" flag for anybody to tick. */
  done!: boolean;
}

export type GettingStartedStepKey =
  | 'companyDetails'
  | 'businessUnits'
  | 'submittedAssessment'
  | 'ropaRecords'
  | 'classifiedData'
  | 'mappingReviewed';

/** The six steps, in order, with how many are complete. */
export class GettingStartedDto {
  completed!: number;
  total!: number;
  @ApiProperty({ type: [GettingStartedStepDto] })
  steps!: GettingStartedStepDto[];
}

/** `GET …/dashboard/summary`: the organisation-wide figures no other endpoint answers for. */
export class DashboardSummaryDto {
  /** Today in the organisation's time zone: the day every count here was decided against. */
  @ApiProperty({ type: String, format: 'date' })
  asOf!: string;
  /** The zone `asOf` is taken in, so a client shows it rather than guesses it. */
  timezone!: string;
  /** The gap, in maturity levels, at which the screen and the report highlight a row. */
  gapHighlightLevels!: number;
  @ApiProperty({ type: MaturityMetricDto })
  maturity!: MaturityMetricDto;
  @ApiProperty({ type: ExposureMetricDto })
  exposure!: ExposureMetricDto;
  @ApiProperty({ type: GettingStartedDto })
  gettingStarted!: GettingStartedDto;
  /** The wording every scored surface carries: a score is not a legal verdict. */
  disclaimer!: string;
}

/** How a set of subjects sits against its targets. */
export class GapBandsDto {
  /** Subjects already at or above their target. */
  met!: number;
  /** Short of target by less than the highlight gap. */
  minor!: number;
  /** Short of target by the highlight gap or more. */
  major!: number;
  /** Subjects with a missing side, so no gap can be stated. Counted, never dropped. */
  unmeasured!: number;
}

/** The framework version a control count was taken from. */
export class FrameworkVersionRefDto {
  id!: string;
  label!: string;
  /** `VERIFIED` or `PUBLISHED`: the only two states a dashboard will read a control count from. */
  status!: string;
}

/**
 * One framework measured inside one governance area. The sample's radar and the area table plot these, so
 * every point is a number the server rolled rather than a name a client guessed at.
 */
export class FrameworkAreaMaturityDto {
  /** Null for subjects not filed under a governance area; `areaName` says that in words. */
  @ApiProperty({ type: String, nullable: true })
  areaId!: string | null;
  areaName!: string;
  /** Subjects of this framework under this area in the organisation's current answers. */
  inScope!: number;
  /** Of those, how many carry a current maturity. */
  rated!: number;
  current!: MeasuredDto;
  target!: MeasuredDto;
  gap!: MeasuredDto;
  /** `not_assessed`: nothing of this framework under this area carries a maturity level. */
  @ApiProperty({ enum: ['ok', 'not_assessed'], enumName: 'FrameworkCoverageAvailability' })
  availability!: 'ok' | 'not_assessed';
}

/** One applicable framework: how big it is, what has been rated of it, and what is still owed. */
export class FrameworkCoverageDto {
  frameworkId!: string;
  code!: string;
  name!: string;
  jurisdiction!: string;
  /** `LAW`, `STANDARD` or `FRAMEWORK`: how the source is described, not a claim about its legal force. */
  kind!: string;
  /** Null when no usable version of this framework is loaded: then no control count can be stated. */
  @ApiProperty({ type: FrameworkVersionRefDto, nullable: true })
  version!: FrameworkVersionRefDto | null;
  /** Requirements that version holds. The platform does not decide which of them apply to the organisation. */
  @ApiProperty({ type: Number, nullable: true })
  catalogueControls!: number | null;
  /** Subjects of this framework in the organisation's current answers. */
  inScope!: number;
  /** Of those, how many carry a current maturity. The rest are counted, never read as zero. */
  rated!: number;
  current!: MeasuredDto;
  target!: MeasuredDto;
  gap!: MeasuredDto;
  @ApiProperty({ type: GapBandsDto })
  gapBands!: GapBandsDto;
  /** Outstanding remediation tasks filed under this framework. */
  outstandingFindings!: number;
  /**
   * `not_assessed`: nothing of this framework has been put into a submitted or approved cycle, or none of
   * it carries a maturity level. It is never a zero percent and never called non-compliant.
   */
  @ApiProperty({ enum: ['ok', 'not_assessed'], enumName: 'FrameworkCoverageAvailability' })
  availability!: 'ok' | 'not_assessed';
  @ApiProperty({ enum: DASHBOARD_STATUSES, nullable: true })
  status!: DashboardStatusValue | null;
  /** This framework's maturity inside each governance area it is rated in, biggest gap first. */
  @ApiProperty({ type: [FrameworkAreaMaturityDto] })
  byArea!: FrameworkAreaMaturityDto[];
}

/** `GET …/dashboard/frameworks`: the comparison bar, the radar, the table and the compliance cards read this. */
export class DashboardFrameworksDto {
  /** `not_configured`: the organisation has declared no framework applicable in Company Settings. */
  @ApiProperty({ enum: ['ok', 'not_configured'], enumName: 'FrameworksAvailability' })
  availability!: 'ok' | 'not_configured';
  @ApiProperty({ type: String, format: 'date' })
  asOf!: string;
  gapHighlightLevels!: number;
  @ApiProperty({ type: [FrameworkCoverageDto] })
  frameworks!: FrameworkCoverageDto[];
  /** What the availability word means here, in the reader's language rather than a code. */
  @ApiProperty({ type: String, nullable: true })
  message!: string | null;
  disclaimer!: string;
}

/** One governance area's distance from its target. */
export class GapAnalysisRowDto {
  /** Null for subjects not filed under a governance area; `areaName` says that in words. */
  @ApiProperty({ type: String, nullable: true })
  areaId!: string | null;
  areaName!: string;
  /** Subjects in the organisation's current answers under this area. */
  items!: number;
  current!: MeasuredDto;
  target!: MeasuredDto;
  gap!: MeasuredDto;
  exposure!: MeasuredDto;
  /** True when the mean gap reaches the highlight gap: the rows to look at first. */
  highlight!: boolean;
  @ApiProperty({ enum: DASHBOARD_STATUSES, nullable: true })
  status!: DashboardStatusValue | null;
}

/** `GET …/dashboard/gap-analysis`: the areas, biggest gap first. */
export class DashboardGapAnalysisDto {
  /** `not_assessed`: no subject has both a current and a target level, so no gap can be stated. */
  @ApiProperty({ enum: ['ok', 'not_assessed'], enumName: 'GapAnalysisAvailability' })
  availability!: 'ok' | 'not_assessed';
  @ApiProperty({ type: String, format: 'date' })
  asOf!: string;
  /** The gap, in levels, at which a row is highlighted: the same number the report uses. */
  highlightAt!: number;
  @ApiProperty({ type: [GapAnalysisRowDto] })
  rows!: GapAnalysisRowDto[];
  disclaimer!: string;
}

/** The outstanding task a top risk is worked through, when one exists. */
export class RelatedTaskDto {
  id!: string;
  title!: string;
  @ApiProperty({ enum: TASK_STATUSES })
  status!: string;
  @ApiProperty({ enum: TASK_PRIORITIES })
  priority!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  dueDate!: string | null;
}

/** One carried risk, ranked by the exposure the register itself stores. */
export class TopRiskDto {
  id!: string;
  title!: string;
  @ApiProperty({ enum: RISK_STATUSES })
  status!: string;
  @ApiProperty({ enum: RISK_CATEGORIES, nullable: true })
  category!: string | null;
  /** The score of the basis asked for; null when the risk is not scored on it. */
  @ApiProperty({ type: Number, nullable: true })
  score!: number | null;
  @ApiProperty({ enum: RISK_LEVELS, nullable: true })
  level!: RiskLevel | null;
  /** The two factors of that basis, so a reader can see what the score is made of. */
  @ApiProperty({ type: Number, nullable: true })
  likelihood!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  severity!: number | null;
  @ApiProperty({ type: String, nullable: true })
  governanceAreaName!: string | null;
  /** Null for a risk that is the whole organisation's. */
  @ApiProperty({ type: String, nullable: true })
  businessUnitName!: string | null;
  /** Null for a risk that is not filed under a framework. */
  @ApiProperty({ type: String, nullable: true })
  frameworkCode!: string | null;
  /** The member who owns the risk, when one is named. */
  @ApiProperty({ type: String, nullable: true })
  ownerName!: string | null;
  /** The register's next-action date for this risk. */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  reviewByDate!: string | null;
  /** The treatment the owner wrote as the next step; null when nobody has stated one. */
  @ApiProperty({ type: String, nullable: true })
  nextAction!: string | null;
  @ApiProperty({ type: RelatedTaskDto, nullable: true })
  task!: RelatedTaskDto | null;
}

/** `GET …/dashboard/top-risks?basis=&limit=`: `risk.top`. */
export class DashboardTopRisksDto {
  @ApiProperty({ enum: BASIS_VALUES, enumName: 'RiskHeatmapBasis' })
  basis!: BasisValue;
  /** `no_records`: the register holds no risk that is still carried. */
  @ApiProperty({ enum: ['ok', 'no_records'], enumName: 'TopRisksAvailability' })
  availability!: 'ok' | 'no_records';
  @ApiProperty({ type: String, format: 'date' })
  asOf!: string;
  /** The number of rows asked for, as it was applied. */
  limit!: number;
  @ApiProperty({ type: [TopRiskDto] })
  items!: TopRiskDto[];
  /** Carried risks with no complete factor pair on this basis: the list has a tail, and it is named. */
  unscored!: number;
  disclaimer!: string;
}

/** The `basis` and `limit` of `GET …/dashboard/top-risks`. */
export class TopRisksQueryDto {
  /** Which pair of factors to rank by: the heat map's own word, so a grid and a list agree. */
  @ApiPropertyOptional({ enum: BASIS_VALUES, enumName: 'RiskHeatmapBasis', default: 'residual' })
  @IsOptional()
  @IsIn(BASIS_VALUES)
  basis?: BasisValue;

  @ApiPropertyOptional({ type: Number, default: 10, minimum: 1, maximum: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;
}
