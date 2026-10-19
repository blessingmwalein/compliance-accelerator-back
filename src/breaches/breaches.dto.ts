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
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DeadlineViewDto } from '../common/deadline-view.js';
import { PageQueryDto } from '../common/pagination.js';
import { OptionalOrNull, TrimText, TrimToNull } from '../common/validators/nullable.js';
import {
  BREACH_CHRONOLOGY_KINDS,
  BREACH_DECISION_KINDS,
  BREACH_NOTIFICATION_STATES,
  BREACH_STATUSES,
  type BreachChronologyKind,
  type BreachNotificationDecisionKind,
  type BreachNotificationState,
  type BreachStatus,
} from '../domain/incidents/breach.js';
import { RISK_LEVELS, type RiskLevel } from '../domain/scoring/methodologies.js';

const toBoolean = ({ value }: { value: unknown }) => value === 'true' || value === true;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';

/** A step this caller may take from the breach's current status. */
export class BreachStatusTransitionDto {
  @ApiProperty({ enum: BREACH_STATUSES, enumName: 'BreachStatus' })
  toStatus!: BreachStatus;

  /** `approve`: only an approver may take this step. `work`: anyone who may edit the registry. */
  @ApiProperty({ enum: ['work', 'approve'] })
  by!: 'work' | 'approve';

  needsReason!: boolean;
}

/** A row of the append-only timeline: how the breach was found, what was done, what was learned. */
export class BreachChronologyEntryDto {
  id!: string;
  breachId!: string;

  @ApiProperty({ enum: BREACH_CHRONOLOGY_KINDS, enumName: 'BreachChronologyKind' })
  kind!: BreachChronologyKind;

  @ApiProperty({ type: String, format: 'date' })
  occurredOn!: string;

  note!: string;
  createdByUserId!: string;
  createdByName!: string | null;
  createdAt!: string;
}

/** One notification decision. The ledger only grows: a reversed decision adds a row, it erases nothing. */
export class BreachNotificationDecisionDto {
  id!: string;
  breachId!: string;

  @ApiProperty({ enum: BREACH_DECISION_KINDS, enumName: 'BreachNotificationDecisionKind' })
  decision!: BreachNotificationDecisionKind;

  /** The state this decision left the duty in — derived by the server, never sent by a client. */
  @ApiProperty({ enum: BREACH_NOTIFICATION_STATES, enumName: 'BreachNotificationState' })
  notificationState!: BreachNotificationState;

  regulatorContactId!: string | null;
  /** The authority from the organisation's regulator list, when the decision cites one. */
  regulatorAuthorityName!: string | null;
  /** Or the authority typed in for this decision, when it is not in the list. */
  authorityName!: string | null;

  /** The day the notification is to be made by; only a REQUIRED decision has one. */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  targetDate!: string | null;

  reason!: string;
  decidedByUserId!: string;
  decidedByName!: string | null;
  decidedAt!: string;
}

/** An evidence file attached to the breach. The file itself belongs to the evidence repository. */
export class BreachEvidenceDto {
  evidenceId!: string;
  title!: string;
  currentVersion!: number;
  linkedAt!: string;
}

/** A breach in the registry, with the two deadline views the registry exists to show. */
export class BreachDto {
  id!: string;
  title!: string;
  description!: string | null;

  @ApiProperty({ enum: BREACH_STATUSES, enumName: 'BreachStatus' })
  status!: BreachStatus;

  @ApiProperty({ type: String, format: 'date' })
  detectedOn!: string;

  /** The categories of data and of subjects affected, in the organisation's own words. */
  affectedData!: string | null;
  affectedSubjectCount!: number | null;

  @ApiProperty({ enum: RISK_LEVELS, enumName: 'RiskLevel', nullable: true })
  severity!: RiskLevel | null;

  impact!: string | null;

  businessUnitId!: string | null;
  businessUnitName!: string | null;
  ownerMembershipId!: string | null;
  ownerName!: string | null;

  /** The policy this breach was measured against, and the two windows it held at the time. */
  policyId!: string | null;
  assessmentDays!: number | null;
  notificationDays!: number | null;

  @ApiProperty({ type: DeadlineViewDto })
  assessmentDeadline!: DeadlineViewDto;

  @ApiProperty({ type: DeadlineViewDto })
  notificationDeadline!: DeadlineViewDto;

  @ApiProperty({ enum: BREACH_NOTIFICATION_STATES, enumName: 'BreachNotificationState' })
  notificationState!: BreachNotificationState;

  /** The duty is answered: a decision is on the ledger, so its deadline is no longer open. */
  notificationSettled!: boolean;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  closedOn!: string | null;
  closedByUserId!: string | null;
  closureNote!: string | null;

  createdByUserId!: string;
  createdAt!: string;
  updatedAt!: string;

  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;

  /** The steps THIS caller may take now, so the UI never offers a forbidden one. */
  @ApiProperty({ type: [BreachStatusTransitionDto] })
  allowedTransitions!: BreachStatusTransitionDto[];
}

/** The detail adds the three short lists a breach is read with; none of them is paginated. */
export class BreachDetailDto extends BreachDto {
  /** Oldest event first: the timeline reads as the story happened. */
  @ApiProperty({ type: [BreachChronologyEntryDto] })
  chronology!: BreachChronologyEntryDto[];

  /** Newest decision first: the head of the ledger is the reading of the duty today. */
  @ApiProperty({ type: [BreachNotificationDecisionDto] })
  decisions!: BreachNotificationDecisionDto[];

  @ApiProperty({ type: [BreachEvidenceDto] })
  evidence!: BreachEvidenceDto[];

  /** At least one decision row exists — the rule a closure is refused on. */
  decisionRecorded!: boolean;
}

export class BreachPageDto {
  @ApiProperty({ type: [BreachDto] })
  items!: BreachDto[];

  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class ListBreachesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: BREACH_STATUSES, enumName: 'BreachStatus' })
  @IsOptional()
  @IsIn(BREACH_STATUSES)
  status?: BreachStatus;

  @ApiPropertyOptional({ enum: BREACH_NOTIFICATION_STATES, enumName: 'BreachNotificationState' })
  @IsOptional()
  @IsIn(BREACH_NOTIFICATION_STATES)
  notificationState?: BreachNotificationState;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  businessUnitId?: string;

  /** The breach model links a business unit and an owner; it carries no governance area. */
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ownerMembershipId?: string;

  /** Only breaches whose notification duty falls due on or before this calendar day. */
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  dueBefore?: string;

  /** Only breaches whose title or description contains this text (case-insensitive). */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Include CLOSED breaches (they are listed by default; set this to false to hide them). */
  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeClosed?: boolean;
}

/** A new breach: what was found, when, and how badly. The deadlines are the server's, not the caller's. */
export class CreateBreachDto {
  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /** Detection day: both frozen windows are counted from it, so it has to be stated. */
  @ApiProperty({ type: String, format: 'date' })
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  detectedOn!: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(4000)
  affectedData?: string | null;

  @OptionalOrNull()
  @IsInt()
  @Min(0)
  affectedSubjectCount?: number | null;

  @OptionalOrNull()
  @IsIn(RISK_LEVELS)
  severity?: RiskLevel | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(4000)
  impact?: string | null;

  @OptionalOrNull()
  @IsUUID()
  businessUnitId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;
}

/** The registry's content. Status, deadlines and decisions each have their own endpoint. */
export class UpdateBreachDto {
  @TrimText()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  affectedData?: string | null;

  @OptionalOrNull()
  @IsOptional()
  @IsInt()
  @Min(0)
  affectedSubjectCount?: number | null;

  @OptionalOrNull()
  @IsIn(RISK_LEVELS)
  severity?: RiskLevel | null;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  impact?: string | null;

  @OptionalOrNull()
  @IsUUID()
  businessUnitId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  /** The `version` of the breach as last read. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** One step along the lifecycle. Closing states the outcome, and only an approver closes. */
export class ChangeBreachStatusDto {
  @ApiProperty({ enum: BREACH_STATUSES, enumName: 'BreachStatus' })
  @IsIn(BREACH_STATUSES)
  toStatus!: BreachStatus;

  /** Mandatory for the steps that say so; a closure keeps this text on the record. */
  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reason?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** One event on the timeline. A step that happened twice is written twice. */
export class AddBreachChronologyDto {
  @ApiProperty({ enum: BREACH_CHRONOLOGY_KINDS, enumName: 'BreachChronologyKind' })
  @IsIn(BREACH_CHRONOLOGY_KINDS)
  kind!: BreachChronologyKind;

  @ApiProperty({ type: String, format: 'date' })
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  occurredOn!: string;

  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  note!: string;
}

/**
 * The notification decision. Which duty the record carries is derived from `decision` here; `version` is
 * the breach's, because appending a decision moves the breach's notification state with it.
 */
export class RecordBreachDecisionDto {
  @ApiProperty({ enum: BREACH_DECISION_KINDS, enumName: 'BreachNotificationDecisionKind' })
  @IsIn(BREACH_DECISION_KINDS)
  decision!: BreachNotificationDecisionKind;

  /** The authority from this organisation's regulator list. One of this or `authorityName`, never both. */
  @OptionalOrNull()
  @IsUUID()
  regulatorContactId?: string | null;

  /** Or the authority named in words. 2 to 200 characters once trimmed. */
  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  authorityName?: string | null;

  /** The day the notification is to be made by; a decision to notify always names one. */
  @TrimToNull()
  @OptionalOrNull()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  targetDate?: string | null;

  /** Why: what the assessment found, in the words the organisation stands behind. */
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

/** Attach a file this organisation has already uploaded. */
export class LinkBreachEvidenceDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  evidenceId!: string;
}

/** The three numbers the registry exists to give, plus the one fact that explains the third. */
export class BreachSummaryDto {
  /** Breaches that are not CLOSED. */
  open!: number;

  /** Breaches detected in the organisation's current calendar year, closed ones included. */
  annualTotal!: number;

  /** Undecided notification duties whose configured date has passed. Needs a policy window to exist. */
  overdue!: number;

  /** False when no notification window is configured: then nothing can be late, and that is not an error. */
  notificationConfigured!: boolean;

  /** Today in the organisation's time zone: the day all three counts were decided against. */
  @ApiProperty({ type: String, format: 'date' })
  today!: string;
}
