import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { TrimText } from '../common/validators/nullable.js';

export const REPORT_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export type ReportStatusValue = (typeof REPORT_STATUSES)[number];

/** The windows the Consolidated DPO Report can cover, named so a client offers the same four the server knows. */
export const DPO_PERIODS = ['last_30_days', 'last_6_months', 'this_year', 'all'] as const;
export type DpoPeriodValue = (typeof DPO_PERIODS)[number];
export const DEFAULT_DPO_PERIOD: DpoPeriodValue = 'last_30_days';

/** How a report takes one of its parameters: the shape the body field has. */
export const REPORT_PARAM_TYPES = ['uuid', 'enum', 'boolean'] as const;
export type ReportParamType = (typeof REPORT_PARAM_TYPES)[number];

/** Whether the document is rendered in the request or by a job that the client polls for. */
export const REPORT_GENERATIONS = ['sync', 'async'] as const;
export type ReportGenerationMode = (typeof REPORT_GENERATIONS)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';

/**
 * The parameters a report was generated with. They are stored as sent, so a report can be re-read. A field
 * that belongs to another template stays null: nothing is invented when the row is read back.
 */
export class ReportParamsDto {
  /** The assessment cycle the report covers; null for a report that spans the whole organisation. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assessmentId!: string | null;
  /** Null = every business unit. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  businessUnitId!: string | null;
  /** Null = every framework the organisation applies. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  frameworkId!: string | null;
  /** The window a Consolidated DPO Report covered; null for a template that takes no period. */
  @ApiProperty({ enum: DPO_PERIODS, enumName: 'DpoPeriod', type: String, nullable: true })
  period!: DpoPeriodValue | null;
  /** Whether the confidentiality marking was printed. Null for a template with no such choice. */
  @ApiProperty({ type: Boolean, nullable: true })
  confidential!: boolean | null;
}

/**
 * A stored report. The bytes are not here: they are served by the download endpoint, and the checksum lets a
 * client prove it holds the same file the server wrote. Both are null while a job has not finished, which is
 * why a client polls this record rather than guessing from the clock.
 */
export class ReportDto {
  id!: string;
  /** One of the catalogue's template ids: `governance_assessment`, `executive_dashboard`, `consolidated_dpo`. */
  template!: string;
  /** The definition version that rendered it, so a later change of layout can be told apart from new data. */
  templateVersion!: number;
  title!: string;
  /** The assessment this report is about (null for a report that spans the organisation). */
  assessmentId!: string | null;
  @ApiProperty({ enum: REPORT_STATUSES, enumName: 'ReportStatus' })
  status!: ReportStatusValue;
  @ApiProperty({ type: ReportParamsDto })
  params!: ReportParamsDto;
  /** Bytes of the stored PDF, measured by the server. Null until the document exists. */
  @ApiProperty({ type: Number, nullable: true })
  size!: number | null;
  /** SHA-256 (hex) of the stored PDF. Null until the document exists. */
  @ApiProperty({ type: String, nullable: true })
  sha256!: string | null;
  /** When it became readable, or when the job gave up. Null while it is PENDING. */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt!: string | null;
  /** Set when `status` is FAILED: the code a client branches on. */
  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;
  /** Set when `status` is FAILED: one sentence in the reader's language, never a stack trace. */
  @ApiProperty({ type: String, nullable: true })
  errorDetail!: string | null;
  requestedByUserId!: string;
  createdAt!: string;
}

export class ReportPageDto {
  items!: ReportDto[];

  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

/** One parameter a template takes, described so the generate form can be built from the contract. */
export class ReportTemplateParamDto {
  /** The body field's name. */
  name!: string;
  @ApiProperty({ enum: REPORT_PARAM_TYPES, enumName: 'ReportParamType' })
  type!: ReportParamType;
  required!: boolean;
  /** What it narrows the document to, in the reader's words. */
  description!: string;
  /** The accepted values when `type` is `enum`; null for the others. */
  @ApiProperty({ type: [String], nullable: true })
  values!: readonly string[] | null;
  /** The value used when the field is omitted, as the text the form shows; null when there is no default. */
  @ApiProperty({ type: String, nullable: true })
  default!: string | null;
}

/** A template this build can render. */
export class ReportTemplateDto {
  /** The id to generate with, and the value `template` carries on stored reports. */
  template!: string;
  version!: number;
  title!: string;
  description!: string;
  @ApiProperty({ enum: REPORT_GENERATIONS, enumName: 'ReportGeneration' })
  generate!: ReportGenerationMode;
  /**
   * The permission the generate route asks for. It is the same value the route's own access decorator
   * carries (`REPORT_PERMISSIONS`), so the catalogue cannot promise a document the guard would refuse.
   */
  permission!: string;
  @ApiProperty({ type: [ReportTemplateParamDto] })
  params!: readonly ReportTemplateParamDto[];
}

/** A template that is named in a later phase: listed so a client can say when instead of leaving it out. */
export class PlannedReportTemplateDto {
  template!: string;
  title!: string;
  /** The phase that writes it, in the plan's own numbering. */
  phase!: string;
}

export class ReportCatalogueDto {
  @ApiProperty({ type: [ReportTemplateDto] })
  items!: readonly ReportTemplateDto[];
  @ApiProperty({ type: [PlannedReportTemplateDto] })
  planned!: readonly PlannedReportTemplateDto[];
}

/** `POST …/reports/governance-assessment`: one cycle, optionally narrowed by unit and framework. */
export class GenerateGovernanceAssessmentDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsString()
  @MinLength(1)
  assessmentId!: string;

  /** `null` or omitted = every business unit. */
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsString()
  businessUnitId?: string | null;

  /** `null` or omitted = every applicable framework. */
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsString()
  frameworkId?: string | null;
}

/**
 * `POST …/reports/consolidated-dpo`: the regulator-facing document over every register for one period. It
 * answers 202 with a PENDING record because the period can span seven registers, which is not request work.
 */
export class GenerateConsolidatedDpoDto {
  @ApiPropertyOptional({
    enum: DPO_PERIODS,
    enumName: 'DpoPeriod',
    default: DEFAULT_DPO_PERIOD,
    description: 'The window the document covers, counted back from the day it is drawn.',
  })
  @IsOptional()
  @IsIn(DPO_PERIODS)
  period?: DpoPeriodValue;

  /** Omit for true: the marking the DPO sends a regulator. */
  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  confidential?: boolean;
}

/** The history list: the same filters a DPO asks with, on the day the document was requested. */
export class ListReportsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 64 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(64)
  template?: string;

  @ApiPropertyOptional({ enum: REPORT_STATUSES, enumName: 'ReportStatus' })
  @IsOptional()
  @IsIn(REPORT_STATUSES)
  status?: ReportStatusValue;

  /** Only the reports of one assessment cycle. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assessmentId?: string;

  /** Only reports requested from this calendar day onward (UTC day start, inclusive). */
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  from?: string;

  /** Only reports requested up to and including this calendar day (the whole UTC day). */
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  to?: string;
}
