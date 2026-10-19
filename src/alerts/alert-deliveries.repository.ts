import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import {
  type AlertKind,
  type AlertSkipReason,
  type AlertStatus,
} from '../domain/incidents/alerts.js';
import { toDateOnly, utcDay } from '../domain/registers/review.js';
import { Prisma } from '../generated/prisma/client.js';
import { RequestContext } from '../tenancy/request-context.js';

/** Which record an alert is about: exactly one of the three columns, of the kind the alert names. */
export type AlertSource = { dsarRequestId: string } | { breachId: string } | { reminderId: string };

export const sourceIdOf = (source: AlertSource): string =>
  'dsarRequestId' in source
    ? source.dsarRequestId
    : 'breachId' in source
      ? source.breachId
      : source.reminderId;

export interface AlertDeliveryRecord {
  id: string;
  kind: AlertKind;
  dedupeKey: string;
  status: AlertStatus;
  recipientAddress: string | null;
  recipientLabel: string | null;
  /** The deadline the alert was raised for, as the organisation's calendar day. */
  dueOn: string | null;
  skipReason: AlertSkipReason | null;
  lastError: string | null;
  attempts: number;
  sentAt: Date | null;
  createdAt: Date;
  dsarRequestId: string | null;
  breachId: string | null;
  reminderId: string | null;
}

/** A row as it is queued: the record, the threshold, and the date the alert names. */
export interface NewAlertDelivery {
  kind: AlertKind;
  dedupeKey: string;
  source: AlertSource;
  dueOn: string | null;
}

/** What happened when the alert ran. These are the only columns a queued row may ever change. */
export type AlertOutcome =
  | { status: 'SENT'; recipientAddress: string; recipientLabel: string; sentAt: Date }
  | { status: 'SKIPPED'; reason: AlertSkipReason }
  | { status: 'FAILED'; error: string };

const SELECT = {
  id: true,
  kind: true,
  dedupeKey: true,
  status: true,
  recipientAddress: true,
  recipientLabel: true,
  dueOn: true,
  skipReason: true,
  lastError: true,
  attempts: true,
  sentAt: true,
  createdAt: true,
  dsarRequestId: true,
  breachId: true,
  reminderId: true,
} as const;

export interface AlertListOptions {
  limit: number;
  after?: string;
  kind?: AlertKind;
  status?: AlertStatus;
  dsarRequestId?: string;
  breachId?: string;
  reminderId?: string;
}

type SelectedRow = Prisma.AlertDeliveryGetPayload<{ select: typeof SELECT }>;

/** The stored row, with the deadline as the calendar day the rest of the phase compares. */
const toRecord = (row: SelectedRow): AlertDeliveryRecord => ({
  ...row,
  dueOn: toDateOnly(row.dueOn),
});

/**
 * The tenant's alert ledger (`alert_deliveries`): one row per record, per threshold, per deadline. The row
 * is created QUEUED and only its outcome changes afterwards; the database trigger refuses every other write
 * and refuses DELETE outright, so "was anybody told" keeps its answer.
 */
@Injectable()
export class AlertDeliveriesRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /**
   * Queue one alert, or return null when the same threshold of the same record was already queued for the
   * same date. That is the idempotency the exit criterion asks for: a second request to alert about an
   * unchanged deadline writes nothing.
   */
  async insertQueued(tx: Tx, row: NewAlertDelivery): Promise<AlertDeliveryRecord | null> {
    const created = await tx.alertDelivery.createManyAndReturn({
      data: [
        {
          organisationId: this.organisationId,
          kind: row.kind,
          dedupeKey: row.dedupeKey,
          status: 'QUEUED',
          dueOn: row.dueOn === null ? null : utcDay(row.dueOn),
          ...row.source,
        },
      ],
      select: SELECT,
      skipDuplicates: true,
    });
    const [first] = created;
    return first === undefined ? null : toRecord(first);
  }

  find(tx: Tx, id: string): Promise<AlertDeliveryRecord | null> {
    return tx.alertDelivery
      .findFirst({ where: { id, organisationId: this.organisationId }, select: SELECT })
      .then((row) => (row === null ? null : toRecord(row)));
  }

  /** The delivery ran: only the outcome columns move, and the attempt counter always increases. */
  async mark(tx: Tx, id: string, outcome: AlertOutcome): Promise<void> {
    await tx.alertDelivery.updateMany({
      where: { id, organisationId: this.organisationId },
      data: {
        ...(outcome.status === 'SENT'
          ? {
              status: 'SENT',
              recipientAddress: outcome.recipientAddress,
              recipientLabel: outcome.recipientLabel,
              sentAt: outcome.sentAt,
            }
          : outcome.status === 'SKIPPED'
            ? { status: 'SKIPPED', skipReason: outcome.reason }
            : { status: 'FAILED', lastError: outcome.error }),
        attempts: { increment: 1 },
      },
    });
  }

  list(tx: Tx, options: AlertListOptions): Promise<AlertDeliveryRecord[]> {
    return tx.alertDelivery
      .findMany({
        where: {
          organisationId: this.organisationId,
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.status ? { status: options.status } : {}),
          ...(options.dsarRequestId ? { dsarRequestId: options.dsarRequestId } : {}),
          ...(options.breachId ? { breachId: options.breachId } : {}),
          ...(options.reminderId ? { reminderId: options.reminderId } : {}),
          ...(options.after ? { id: { gt: options.after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: options.limit + 1,
        select: SELECT,
      })
      .then((rows) => rows.map(toRecord));
  }

  /**
   * Who an incident alert may go to, read at send time: the designated contact and, as the fallback, the
   * addresses of the organisation's active Company Owners (AC-BRC-02 — the recipient may hold no account at
   * all). The memberships come back ordered by id, so a job that runs twice chooses the same person twice.
   */
  async contactFacts(tx: Tx): Promise<{
    name: string;
    timezone: string;
    dpoEmail: string | null;
    ownerEmails: string[];
  }> {
    const row = await tx.organisation.findUnique({
      where: { id: this.organisationId },
      select: {
        name: true,
        timezone: true,
        dpoEmail: true,
        memberships: {
          where: { role: 'COMPANY_OWNER', status: 'ACTIVE' },
          orderBy: { id: 'asc' },
          select: { user: { select: { email: true } } },
        },
      },
    });
    if (!row) {
      throw new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Organisation not found.');
    }
    return {
      name: row.name,
      timezone: row.timezone,
      dpoEmail: row.dpoEmail,
      ownerEmails: row.memberships.map((membership) => membership.user.email),
    };
  }
}
