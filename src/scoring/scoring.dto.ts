import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min, ValidateNested } from 'class-validator';
import { OptionalOrNull } from '../common/validators/nullable.js';
import { RISK_LEVELS } from '../domain/scoring/methodologies.js';

export class BandDto {
  @ApiProperty({ enum: RISK_LEVELS, enumName: 'RiskLevel' })
  key!: (typeof RISK_LEVELS)[number];
  label!: string;
  /** Inclusive lower bound of the score range. */
  min!: number;
  /** Inclusive upper bound of the score range. */
  max!: number;
}

/** Where each of the first three bands ends; Critical runs to the top of the range. */
export class BandThresholdsDto {
  @IsInt()
  lowMax!: number;

  @IsInt()
  mediumMax!: number;

  @IsInt()
  highMax!: number;
}

export class DueDaysDto {
  @IsInt()
  @Min(1)
  @Max(365)
  CRITICAL!: number;

  @IsInt()
  @Min(1)
  @Max(365)
  HIGH!: number;

  @IsInt()
  @Min(1)
  @Max(365)
  MEDIUM!: number;

  @IsInt()
  @Min(1)
  @Max(365)
  LOW!: number;
}

export class PlanWindowDto {
  @IsInt()
  @Min(1)
  @Max(365)
  minDays!: number;

  @IsInt()
  @Min(1)
  @Max(365)
  maxDays!: number;
}

export class ScaleLevelDto {
  value!: number;
  label!: string;
}

export class QuestionDto {
  key!: string;
  text!: string;
}

export class QuadrantInfoDto {
  key!: string;
  label!: string;
  purpose!: string;
  defaultScheduling!: string;
}

export class ExposureMethodologyDto {
  /** `exposure_v1`. */
  id!: string;
  version!: number;
  label!: string;
  formula!: string;
  /** Smallest possible score. */
  rangeMin!: number;
  /** Largest possible score. */
  rangeMax!: number;
  /** The bands in force for this organisation. */
  bands!: BandDto[];
  /** The reference bands (what "reset" returns to). */
  defaultBands!: BandDto[];
  thresholds!: BandThresholdsDto;
  /** True when the organisation changed the reference bands. */
  customised!: boolean;
  /** The scores the formula can actually produce (nothing exists between 81 and 99). */
  attainableValues!: number[];
}

/** The scoring methodology and scheduling policy in force, with the scales and questions the UI needs. */
export class ScoringDto {
  exposure!: ExposureMethodologyDto;
  maturityLevels!: ScaleLevelDto[];
  sensitivityLevels!: ScaleLevelDto[];
  severityLevels!: ScaleLevelDto[];
  likelihoodLevels!: ScaleLevelDto[];
  /** Days until a new remediation task is due, by priority. */
  remediationDueDays!: DueDaysDto;
  defaultRemediationDueDays!: DueDaysDto;
  customisedRemediationDueDays!: boolean;
  /** The scheduling window of the Plan quadrant, in days. */
  planWindowDays!: PlanWindowDto;
  defaultPlanWindowDays!: PlanWindowDto;
  customisedPlanWindowDays!: boolean;
  urgencyQuestions!: QuestionDto[];
  importanceQuestions!: QuestionDto[];
  quadrants!: QuadrantInfoDto[];
  /** Send it back with every change (0 = nothing customised yet). */
  version!: number;
  /** Assessments and scores are informative aids, not legal advice. */
  disclaimer!: string;
}

/** Omit a field to keep it; send `null` to return it to the reference default. */
export class UpdateScoringDto {
  @OptionalOrNull()
  @ValidateNested()
  @Type(() => BandThresholdsDto)
  exposureThresholds?: BandThresholdsDto | null;

  @OptionalOrNull()
  @ValidateNested()
  @Type(() => DueDaysDto)
  remediationDueDays?: DueDaysDto | null;

  @OptionalOrNull()
  @ValidateNested()
  @Type(() => PlanWindowDto)
  planWindowDays?: PlanWindowDto | null;

  /** The `version` of the policy as last read (0 when nothing has been customised yet). */
  @IsInt()
  @Min(0)
  version!: number;
}
