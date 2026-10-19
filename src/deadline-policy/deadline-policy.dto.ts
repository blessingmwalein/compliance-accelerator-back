import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { OptionalOrNull } from '../common/validators/nullable.js';

/**
 * The organisation's own deadline choices. Every value is nullable, and `null` is a real answer, not a gap:
 * a record that would have read an unset window has no deadline and reports `not_configured`. The platform
 * ships no statutory number for any of them (skill grc-domain, section 7).
 */
export class DeadlinePolicyDto {
  @ApiProperty({ type: Number, nullable: true })
  dsarResponseDays!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  dsarExtensionDays!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  dsarExtensionLimit!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  breachAssessmentDays!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  breachNotificationDays!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  alertLeadDays!: number | null;

  /** True when at least one window is configured: what decides whether a screen says "Not configured". */
  configured!: boolean;

  /** Send it back with every change (0 when nothing has been set yet). */
  version!: number;

  disclaimer!: string;
}

/** Omit a field to keep it; send `null` to unset it, which takes the records that used it back to `not_configured`. */
export class UpdateDeadlinePolicyDto {
  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(3660)
  dsarResponseDays?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(3660)
  dsarExtensionDays?: number | null;

  /** How many extensions one request may take. Unset means this organisation records none. */
  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(12)
  dsarExtensionLimit?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(3660)
  breachAssessmentDays?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(1)
  @Max(3660)
  breachNotificationDays?: number | null;

  /** How early a deadline warns. `0` means only on the day itself; unset means no early warning at all. */
  @ApiPropertyOptional({ type: Number, nullable: true })
  @OptionalOrNull()
  @IsInt()
  @Min(0)
  @Max(366)
  alertLeadDays?: number | null;

  /** The `version` of the policy as last read (0 when nothing has been set yet). */
  @IsInt()
  @Min(0)
  version!: number;
}
