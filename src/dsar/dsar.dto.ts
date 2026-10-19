import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
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
import {
  EmailToNull,
  OptionalOrNull,
  TrimText,
  TrimToNull,
} from '../common/validators/nullable.js';
import {
  DSAR_COMMUNICATION_KINDS,
  DSAR_IDENTITY_STATES,
  DSAR_REQUEST_TYPES,
  DSAR_STATUSES,
  type DsarCommunicationKind,
  type DsarIdentityState,
  type DsarRequestType,
  type DsarStatus,
} from '../domain/incidents/dsar.js';
import {
  EVIDENCE_REVIEW_STATUSES,
  type EvidenceReviewStatus,
} from '../domain/incidents/evidence.js';

const toBoolean = ({ value }: { value: unknown }) => value === 'true' || value === true;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';

/** A step this caller may take from the request's current status. */
export class DsarStatusTransitionDto {
  @ApiProperty({ enum: DSAR_STATUSES, enumName: 'DsarStatus' })
  toStatus!: DsarStatus;
  /** `work`: whoever owns the case; `approve`: only an approver may end it. */
  @ApiProperty({ enum: ['work', 'approve'] })
  by!: 'work' | 'approve';
  /** A written outcome has to come with the step. */
  needsNote!: boolean;
  /** Proof has to be attached to the record before the move is allowed. */
  needsEvidence!: boolean;
}

/** A data subject request. `subjectName`, `subjectEmail` and `summary` are personal data: they stay here. */
export class DsarRequestDto {
  id!: string;

  @ApiProperty({ enum: DSAR_REQUEST_TYPES, enumName: 'DsarRequestType' })
  requestType!: DsarRequestType;

  summary!: string | null;
  subjectName!: string | null;
  subjectEmail!: string | null;

  @ApiProperty({ enum: DSAR_STATUSES, enumName: 'DsarStatus' })
  status!: DsarStatus;

  @ApiProperty({ enum: DSAR_IDENTITY_STATES, enumName: 'DsarIdentityState' })
  identityState!: DsarIdentityState;

  @ApiProperty({ type: String, format: 'date' })
  receivedOn!: string;

  businessUnitId!: string | null;
  businessUnitName!: string | null;
  ownerMembershipId!: string | null;
  ownerName!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  /** The policy row this request was measured against. Never recomputed from today's policy. */
  policyId!: string | null;
  @ApiProperty({ type: Number, nullable: true })
  responseDays!: number | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  baseDueOn!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  dueOn!: string | null;
  /** The days granted by the extension ledger, and how many extensions it holds. */
  extensionDays!: number;
  extensionCount!: number;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  identityVerifiedOn!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  identityVerifiedByUserId!: string | null;
  identityNote!: string | null;

  /** The words of the outcome. Present exactly when the request is closed. */
  closureNote!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  completedOn!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  completedByUserId!: string | null;

  createdByUserId!: string;
  createdAt!: string;
  updatedAt!: string;

  /** Send it back with every change: a stale value is rejected with 409 `VERSION_CONFLICT`. */
  version!: number;

  @ApiProperty({ type: DeadlineViewDto })
  deadline!: DeadlineViewDto;

  /** The steps THIS caller may take now, so the UI never offers a forbidden one. */
  @ApiProperty({ type: [DsarStatusTransitionDto] })
  allowedTransitions!: DsarStatusTransitionDto[];
}

/** One entry of the communication log: append-only, and never the body of the message. */
export class DsarCommunicationDto {
  id!: string;
  @ApiProperty({ enum: DSAR_COMMUNICATION_KINDS, enumName: 'DsarCommunicationKind' })
  kind!: DsarCommunicationKind;
  @ApiProperty({ type: String, format: 'date' })
  occurredOn!: string;
  note!: string;
  createdByUserId!: string;
  createdAt!: string;
}

/** An evidence file attached to the request: the record's own title and version pointer, nothing more. */
export class DsarEvidenceDto {
  evidenceId!: string;
  title!: string;
  @ApiProperty({
    enum: EVIDENCE_REVIEW_STATUSES,
    enumName: 'EvidenceReviewStatus',
  })
  reviewStatus!: EvidenceReviewStatus;
  currentVersion!: number;
  linkedByUserId!: string;
  linkedAt!: string;
}

/** The request with its chronology: both sub-lists are short, so neither is paginated. */
export class DsarRequestDetailDto extends DsarRequestDto {
  @ApiProperty({ type: [DsarCommunicationDto] })
  communications!: DsarCommunicationDto[];
  @ApiProperty({ type: [DsarEvidenceDto] })
  evidence!: DsarEvidenceDto[];
}

export class DsarRequestPageDto {
  @ApiProperty({ type: [DsarRequestDto] })
  items!: DsarRequestDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

export class ListDsarQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DSAR_STATUSES, enumName: 'DsarStatus' })
  @IsOptional()
  @IsIn(DSAR_STATUSES)
  status?: DsarStatus;

  @ApiPropertyOptional({ enum: DSAR_REQUEST_TYPES, enumName: 'DsarRequestType' })
  @IsOptional()
  @IsIn(DSAR_REQUEST_TYPES)
  requestType?: DsarRequestType;

  @ApiPropertyOptional({ enum: DSAR_IDENTITY_STATES, enumName: 'DsarIdentityState' })
  @IsOptional()
  @IsIn(DSAR_IDENTITY_STATES)
  identityState?: DsarIdentityState;

  /** Only requests whose deadline falls on or before this calendar day. */
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  dueBefore?: string;

  /** Case-insensitive text over the request's own reference fields and its notes. */
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Hide COMPLETED, REFUSED and WITHDRAWN requests (they are listed by default). */
  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeClosed?: boolean;
}

/** `dsar.sla`: the four counted buckets, the bucket reported apart, and nothing guessed between them. */
export class DsarSlaDto {
  @ApiProperty({
    enum: ['not_configured', 'no_records', 'measured'],
    enumName: 'DsarSlaState',
  })
  state!: 'not_configured' | 'no_records' | 'measured';
  /** Whether a response window is in force at all: without one there is nothing to measure. */
  configured!: boolean;
  /** The response window in force, the number the requests were measured against; null when none is set. */
  @ApiProperty({ type: Number, nullable: true })
  windowDays!: number | null;
  records!: number;
  withinSla!: number;
  completedLate!: number;
  openPastDeadline!: number;
  /** Reported apart and excluded from the percentage: not late yet is neither success nor failure. */
  openNotYetDue!: number;
  breached!: number;
  @ApiProperty({ type: Number, format: 'float', nullable: true })
  /** `withinSla / (withinSla + breached)`, one decimal; null when that denominator is empty. */
  percentage!: number | null;
  /** Today in the organisation's zone: the day every bucket was decided against. */
  @ApiProperty({ type: String, format: 'date' })
  today!: string;
}

/** A new request: what a person states. The deadline and its numbers are frozen by the server. */
export class CreateDsarRequestDto {
  @ApiProperty({ enum: DSAR_REQUEST_TYPES, enumName: 'DsarRequestType' })
  @IsIn(DSAR_REQUEST_TYPES)
  requestType!: DsarRequestType;

  /** The day the organisation received it: every frozen date is measured from here. */
  @ApiProperty({ type: String, format: 'date' })
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  receivedOn!: string;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(2000)
  summary?: string | null;

  @TrimToNull()
  @OptionalOrNull()
  @IsString()
  @MaxLength(120)
  subjectName?: string | null;

  @EmailToNull()
  @OptionalOrNull()
  @IsEmail()
  @MaxLength(320)
  subjectEmail?: string | null;

  @OptionalOrNull()
  @IsUUID()
  businessUnitId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;
}

/** The request's content. Dates, the deadline and the closure are decided by their own endpoints. */
export class UpdateDsarRequestDto {
  @ApiPropertyOptional({ enum: DSAR_REQUEST_TYPES, enumName: 'DsarRequestType' })
  @IsOptional()
  @IsIn(DSAR_REQUEST_TYPES)
  requestType?: DsarRequestType;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string | null;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subjectName?: string | null;

  @EmailToNull()
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  subjectEmail?: string | null;

  @OptionalOrNull()
  @IsUUID()
  businessUnitId?: string | null;

  @OptionalOrNull()
  @IsUUID()
  ownerMembershipId?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

export class ChangeDsarStatusDto {
  @ApiProperty({ enum: DSAR_STATUSES, enumName: 'DsarStatus' })
  @IsIn(DSAR_STATUSES)
  toStatus!: DsarStatus;

  /** Mandatory for the steps that say so, and it becomes the record's stated outcome. */
  @TrimToNull()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  note?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** Proof of identity: the day it was checked and the case worker's note about how. */
export class VerifyDsarIdentityDto {
  @TrimToNull()
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  verifiedOn?: string | null;

  @TrimToNull()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}

/** Grant one more extension. The days it adds come from the policy; the reason is the caller's. */
export class ExtendDsarRequestDto {
  @TrimText()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

/** One line of the communication log. The body of what was written is never stored here. */
export class AddDsarCommunicationDto {
  @ApiProperty({ enum: DSAR_COMMUNICATION_KINDS, enumName: 'DsarCommunicationKind' })
  @IsIn(DSAR_COMMUNICATION_KINDS)
  kind!: DsarCommunicationKind;

  @ApiProperty({ type: String, format: 'date' })
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  @IsDateString()
  occurredOn!: string;

  @TrimText()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  note!: string;
}

/** Attaching a file this organisation already uploaded. */
export class LinkDsarEvidenceDto {
  @IsUUID()
  evidenceId!: string;
}
