import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { TrimText } from '../common/validators/nullable.js';
import { AUDIT_ACTIONS, type AuditAction } from './audit-actions.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_MESSAGE = 'date must be a calendar date in the form YYYY-MM-DD';

export const AUDIT_ACTOR_TYPES = ['USER', 'SYSTEM'] as const;
export type AuditActorTypeValue = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_OUTCOMES = ['SUCCESS', 'DENIED', 'FAILURE'] as const;
export type AuditOutcomeValue = (typeof AUDIT_OUTCOMES)[number];

/**
 * One stored event, exactly as the append-only table holds it. Nothing here is computed: the trail is a
 * record of what happened, so a field is either present because it was written then, or null.
 */
export class AuditEventDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  /** The database clock at the moment of the change — never a client-supplied time. */
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ enum: AUDIT_ACTOR_TYPES, enumName: 'AuditActorType' })
  actorType!: AuditActorTypeValue;

  /**
   * Who acted, by id and never by name or address: `audit.view` reaches a Compliance Manager while
   * `users.view` does not, so the trail cannot hand out member data the caller could not otherwise read.
   * Null when `actorType` is `SYSTEM`, which is a job acting on the organisation's own settings.
   */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorUserId!: string | null;

  @ApiProperty({ enum: AUDIT_ACTIONS, enumName: 'AuditAction' })
  action!: AuditAction;

  /** The kind of record acted on (`report`, `dsar_request`, …). Free text by design: it outlives any module. */
  @ApiProperty({ type: String })
  entityType!: string;

  @ApiProperty({ type: String, nullable: true })
  entityId!: string | null;

  /** The name or code as it read at the time, so the row stays understandable after a rename. */
  @ApiProperty({ type: String, nullable: true })
  entityLabel!: string | null;

  @ApiProperty({ enum: AUDIT_OUTCOMES, enumName: 'AuditOutcome' })
  outcome!: AuditOutcomeValue;

  /** Ties every event of one request together, including the ones a rejected request still wrote. */
  @ApiProperty({ type: String, nullable: true })
  requestId!: string | null;

  /** Field-level before/after values, redacted when written. Secrets never reach this column. */
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  changes!: Record<string, unknown> | null;
}

export class AuditEventPageDto {
  items!: AuditEventDto[];

  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

/**
 * The trail is read newest first, so the filters are the ones a DPO or an auditor actually asks with:
 * a period, who, what kind of action, and which record. `changes` is deliberately not searchable —
 * free-text search inside JSON would be a sequential scan over an append-only table.
 */
export class ListAuditQueryDto extends PageQueryDto {
  /** Only events from this calendar day onward (UTC day start, inclusive). */
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  from?: string;

  /** Only events up to and including this calendar day (the whole UTC day, so a time of day cannot hide one). */
  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MESSAGE })
  to?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ enum: AUDIT_ACTIONS, enumName: 'AuditAction' })
  @IsOptional()
  @IsIn(AUDIT_ACTIONS)
  action?: AuditAction;

  @ApiPropertyOptional({ type: String, maxLength: 60 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(60)
  entityType?: string;

  @ApiPropertyOptional({ type: String, maxLength: 64 })
  @IsOptional()
  @TrimText()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional({ enum: AUDIT_OUTCOMES, enumName: 'AuditOutcome' })
  @IsOptional()
  @IsIn(AUDIT_OUTCOMES)
  outcome?: AuditOutcomeValue;
}
