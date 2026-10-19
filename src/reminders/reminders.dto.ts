import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
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
import { DeadlineViewDto } from '../common/deadline-view.js';
import { PageQueryDto } from '../common/pagination.js';
import { OptionalOrNull, TrimText, TrimToNull } from '../common/validators/nullable.js';
import {
  REMINDER_SOURCE_KINDS,
  REMINDER_STATUSES,
  type ReminderSourceKind,
  type ReminderStatus,
} from '../domain/incidents/reminders.js';

const toBoolean = ({ value }: { value: unknown }) => value === 'true' || value === true;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';

/**
 * A reminder: a date the organisation wanted to be told about, who owns it, and how it ended. Nothing here
 * is deleted — a reminder's life ends at DONE or CANCELLED and both leave their stamp and their author.
 */
export class ReminderDto {
  id!: string;
  title!: string;
  note!: string | null;

  @ApiProperty({ type: String, format: 'date' })
  dueOn!: string;

  /** The reminder's own early-warning window; null means the organisation's policy decides it. */
  @ApiProperty({ type: Number, nullable: true })
  leadDays!: number | null;

  @ApiProperty({ enum: REMINDER_STATUSES, enumName: 'ReminderStatus' })
  status!: ReminderStatus;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assigneeMembershipId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  assigneeName!: string | null;

  /** The ROLE the alert was addressed to, never a person: what the email says beside the link. */
  @ApiProperty({ type: String, nullable: true })
  assigneeLabel!: string | null;

  @ApiProperty({
    enum: REMINDER_SOURCE_KINDS,
    enumName: 'ReminderSourceKind',
    nullable: true,
  })
  sourceKind!: ReminderSourceKind | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sourceId!: string | null;

  /** The reference as it read when the reminder was made; stays readable after the record is renamed. */
  @ApiProperty({ type: String, nullable: true })
  sourceLabel!: string | null;

  deadline!: DeadlineViewDto;

  createdByUserId!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedOn!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  completedByUserId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledOn!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  cancelledByUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason!: string | null;

  createdAt!: string;
  updatedAt!: string;

  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;
}

export class ReminderPageDto {
  items!: ReminderDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class ListRemindersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: REMINDER_STATUSES, enumName: 'ReminderStatus' })
  @IsOptional()
  @IsIn(REMINDER_STATUSES)
  status?: ReminderStatus;

  @ApiPropertyOptional({ enum: REMINDER_SOURCE_KINDS, enumName: 'ReminderSourceKind' })
  @IsOptional()
  @IsIn(REMINDER_SOURCE_KINDS)
  sourceKind?: ReminderSourceKind;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assigneeMembershipId?: string;

  /** Only reminders due on or before this calendar day. */
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  dueBefore?: string;

  /** Text on the columns the reminder itself holds: `title`, `note`, `sourceLabel`. */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Include DONE and CANCELLED reminders (they are listed by default; set this to false to hide them). */
  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeSettled?: boolean;
}

/**
 * A new reminder. Status is not accepted here: a reminder starts PENDING and only the status endpoint ends
 * it. `sourceKind` and `sourceId` come together or not at all, which is what the table's CHECK enforces.
 */
export class CreateReminderDto {
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  dueOn!: string;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 366 })
  @OptionalOrNull()
  @IsInt()
  @Min(0)
  @Max(366)
  leadDays?: number | null;

  /** An ACTIVE member of this organisation, or nobody: an unassigned reminder raises no personal alert. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @OptionalOrNull()
  @IsUUID()
  assigneeMembershipId?: string | null;

  @ApiPropertyOptional({ enum: REMINDER_SOURCE_KINDS, enumName: 'ReminderSourceKind' })
  @OptionalOrNull()
  @IsIn(REMINDER_SOURCE_KINDS)
  sourceKind?: ReminderSourceKind | null;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @OptionalOrNull()
  @IsUUID()
  sourceId?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 120 })
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  sourceLabel?: string | null;
}

/**
 * The reminder's content, its assignee and its date. `dueOn` cannot be cleared (the column is NOT NULL) and
 * a settled reminder cannot be edited at all.
 */
export class UpdateReminderDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string | null;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  dueOn?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assigneeMembershipId?: string | null;

  /** The `version` of the reminder as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** Settle a reminder. Only the two steps the transition table lists exist, and both are final. */
export class ChangeReminderStatusDto {
  @ApiProperty({ enum: REMINDER_STATUSES, enumName: 'ReminderStatus' })
  @IsIn(REMINDER_STATUSES)
  toStatus!: ReminderStatus;

  /** Mandatory for a cancellation: cancelling a date somebody set has to say why. */
  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * The signed-in member's own email choices for reminders addressed to them (AC-REMD-01). A member who never
 * saved anything gets `REMINDER_PREFERENCE_DEFAULTS` (both on), so `version` 0 means "no row yet".
 */
export class ReminderPreferencesDto {
  @ApiProperty({ type: String, format: 'uuid' })
  membershipId!: string;

  /** Null until the first save: the two choices below are then the defaults, not stored values. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  id!: string | null;

  emailDueSoon!: boolean;
  emailOverdue!: boolean;

  /** False until this member has saved a choice: what is shown is then the platform default. */
  configured!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  savedAt!: string | null;

  /** 0 when no row exists yet, 1 once it does. Send it back on the write. */
  version!: number;
}

/** Omit a choice to keep it; both are NOT NULL columns, so `null` is a refusal rather than a write. */
export class UpdateReminderPreferencesDto {
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  emailDueSoon?: boolean | null;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  emailOverdue?: boolean | null;

  /** The `version` of `GET …/reminders/preferences` as last read. */
  @IsInt()
  @Min(0)
  @Max(1)
  version!: number;
}
