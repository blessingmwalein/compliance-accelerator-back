import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export const REPORT_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export type ReportStatusValue = (typeof REPORT_STATUSES)[number];

/** The parameters a report was generated with. They are stored as sent, so a report can be re-read. */
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
}

/**
 * A stored report. The bytes are not here: they are served by the download endpoint, and the checksum lets a
 * client prove it holds the same file the server wrote.
 */
export class ReportDto {
  id!: string;
  /** `governance_assessment` (one cycle) or `executive_dashboard` (the whole organisation); the rest of the catalogue is Phase 9a. */
  template!: string;
  title!: string;
  /** The assessment this report is about (null for a report that spans the organisation). */
  assessmentId!: string | null;
  @ApiProperty({ enum: REPORT_STATUSES, enumName: 'ReportStatus' })
  status!: ReportStatusValue;
  @ApiProperty({ type: ReportParamsDto })
  params!: ReportParamsDto;
  /** Bytes of the stored PDF, measured by the server. */
  size!: number;
  /** SHA-256 (hex) of the stored PDF. */
  sha256!: string;
  requestedByUserId!: string;
  createdAt!: string;
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
