import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import {
  ALERT_KINDS,
  ALERT_SKIP_REASONS,
  ALERT_STATUSES,
  type AlertKind,
  type AlertSkipReason,
  type AlertStatus,
} from '../domain/incidents/alerts.js';

/**
 * One row of the organisation's alert ledger: a threshold of a record, where it was meant to go, and what
 * happened. `recipientAddress` is filled only once the message actually left, so a QUEUED or SKIPPED row
 * shows the intent without pretending a send.
 */
export class AlertDeliveryDto {
  id!: string;

  @ApiProperty({ enum: ALERT_KINDS, enumName: 'AlertKind' })
  kind!: AlertKind;

  @ApiProperty({ enum: ALERT_STATUSES, enumName: 'AlertStatus' })
  status!: AlertStatus;

  /** The record the alert names, whichever of the three it is. */
  recordId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  dsarRequestId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  breachId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reminderId!: string | null;

  /** The deadline this alert was raised for. Null for an alert about an event, not a date. */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  dueOn!: string | null;

  @ApiProperty({ enum: ALERT_SKIP_REASONS, enumName: 'AlertSkipReason', nullable: true })
  skipReason!: AlertSkipReason | null;

  @ApiProperty({ type: String, nullable: true })
  recipientAddress!: string | null;

  /** A role, never a person's name. */
  @ApiProperty({ type: String, nullable: true })
  recipientLabel!: string | null;

  /** The provider's message, sanitised; set only on a FAILED row. */
  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;

  /** How many times the row has run. A retried job that skipped still counts. */
  attempts!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  sentAt!: string | null;

  createdAt!: string;
}

export class AlertDeliveryPageDto {
  items!: AlertDeliveryDto[];
  /** Pass as `after` to get the next page; null on the last page. */
  nextCursor!: string | null;
}

/** The delivery history, filterable by kind, outcome and record. */
export class ListAlertDeliveriesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ALERT_KINDS, enumName: 'AlertKind' })
  @IsOptional()
  @IsIn(ALERT_KINDS)
  kind?: AlertKind;

  @ApiPropertyOptional({ enum: ALERT_STATUSES, enumName: 'AlertStatus' })
  @IsOptional()
  @IsIn(ALERT_STATUSES)
  status?: AlertStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  dsarRequestId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  breachId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  reminderId?: string;
}
