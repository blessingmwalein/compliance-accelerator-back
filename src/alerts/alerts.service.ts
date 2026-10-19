import { Injectable } from '@nestjs/common';
import { AuthSettings } from '../auth/auth-settings.js';
import { Clock } from '../common/clock.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import {
  ASSIGNEE_RECIPIENT_LABEL,
  alertDedupeKey,
  alertRecipientOf,
  isPreferenceGoverned,
  type AlertKind,
  type AlertSkipReason,
} from '../domain/incidents/alerts.js';
import { alertInstantOn } from '../domain/incidents/deadline.js';
import { addDays } from '../domain/remediation/policy.js';
import { sanitiseError } from '../jobs/backoff.js';
import { JobsService } from '../jobs/jobs.service.js';
import { MailService } from '../mail/mail.service.js';
import { RequestContext } from '../tenancy/request-context.js';
import {
  AlertDeliveriesRepository,
  sourceIdOf,
  type AlertDeliveryRecord,
  type AlertSource,
} from './alert-deliveries.repository.js';
import { ALERT_JOB_TYPES, ALERT_PAGES, ALERT_SUMMARIES } from './alert-jobs.js';
import type {
  AlertDeliveryDto,
  AlertDeliveryPageDto,
  ListAlertDeliveriesQueryDto,
} from './alerts.dto.js';

/** One alert waiting to be queued: the threshold, the record, and the deadline it names. */
export interface AlertRequest {
  kind: AlertKind;
  source: AlertSource;
  /** The frozen deadline the alert is about, as a calendar day; null for an alert with no date. */
  dueOn: string | null;
}

/** What the record still says, re-read by its own module at send time. */
export interface AlertRecordFacts {
  /** The record no longer needs this alert: it is closed, or it was never the tenant's to read. */
  settled: boolean;
  /** Its deadline today: an alert whose date has moved is a different alert, not a repeat of this one. */
  dueOn: string | null;
}

/** The person a reminder's own alert goes to, and whether their email choice allows this threshold. */
export interface AlertAddressee {
  address: string;
  emailAllowed: boolean;
}

/**
 * The tenant's alert queue (AC-BRC-02, AC-REMD-01). A feature module calls `queueDeadlines` in the same
 * transaction that writes the record, so a deadline and the promise to warn about it are never out of step,
 * and calls `deliver` from its job handler at send time.
 *
 * This is not a second copy of the mail service's `email_deliveries`: that table is global and keyed on the
 * address. This one is the organisation's ledger of which threshold of which record was raised, and it is
 * what makes "no duplicate sends per threshold" a fact anybody can check afterwards.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly deliveries: AlertDeliveriesRepository,
    private readonly jobs: JobsService,
    private readonly mail: MailService,
    private readonly settings: AuthSettings,
    private readonly requestContext: RequestContext,
    private readonly clock: Clock,
  ) {}

  /**
   * Queue one alert. A row already queued for this record, threshold and date means the same deadline was
   * written twice: nothing is queued again, and nothing is ever sent twice.
   */
  async queue(tx: Tx, alert: AlertRequest, runAt: Date): Promise<void> {
    const key = alertDedupeKey(alert.kind, sourceIdOf(alert.source), alert.dueOn);
    const row = await this.deliveries.insertQueued(tx, { ...alert, dedupeKey: key });
    if (row === null) return;
    await this.jobs.enqueue(
      {
        type: ALERT_JOB_TYPES[alert.kind],
        payload: { organisationId: this.requestContext.requireOrganisationId(), alertId: row.id },
        runAt,
        dedupeKey: key,
      },
      tx,
    );
  }

  /**
   * Queue the two thresholds of one dated record: the early warning (only when the organisation configured a
   * lead) and the day after the deadline. Both are timed for the morning in the tenant's own zone, so a
   * deadline is never announced as passed while it still has hours to run.
   */
  async queueDeadlines(
    tx: Tx,
    args: {
      dueSoon: AlertKind;
      overdue: AlertKind;
      source: AlertSource;
      dueOn: string;
      leadDays: number | null;
      timezone: string;
    },
  ): Promise<void> {
    await this.queue(
      tx,
      { kind: args.overdue, source: args.source, dueOn: args.dueOn },
      alertInstantOn(addDays(args.dueOn, 1), args.timezone),
    );
    if (args.leadDays === null) return;
    const warnOn = addDays(args.dueOn, -args.leadDays);
    // a lead that reaches the deadline day itself would raise a second alert for the same moment
    if (warnOn >= args.dueOn) return;
    await this.queue(
      tx,
      { kind: args.dueSoon, source: args.source, dueOn: args.dueOn },
      alertInstantOn(warnOn, args.timezone),
    );
  }

  /**
   * Send one queued alert, or record why it did not. Every step is its own short transaction: the message
   * leaves the process between them, so no database transaction is ever held open across a send.
   *
   * A handler runs at least once, so the first question is whether the row still needs sending. `facts` is
   * what the record says now, read by the module that owns it: an alert whose record has been closed, or
   * whose deadline has moved, is skipped — and stays on the ledger as proof that the re-run was recognised
   * rather than obeyed.
   */
  async deliver(args: {
    alertId: string;
    /** The record as it is now; null when the owning module could not read it at all. */
    facts: AlertRecordFacts | null;
    /** Whom a reminder's alert is addressed to. Required for the two reminder kinds, ignored for the rest. */
    addressee?: AlertAddressee | null;
  }): Promise<void> {
    const row = await this.uow.run((tx) => this.deliveries.find(tx, args.alertId));
    if (row === null || row.status !== 'QUEUED') return;

    // An incident alert is not a preference and cannot be silenced by one, so an addressee is read only for
    // the kinds that are preference-governed.
    const addressee = isPreferenceGoverned(row.kind) ? (args.addressee ?? null) : null;
    const skip = skipReasonOf(row, args.facts, addressee);
    if (skip !== null) {
      await this.uow.run((tx) =>
        this.deliveries.mark(tx, row.id, { status: 'SKIPPED', reason: skip }),
      );
      return;
    }

    const contacts = await this.uow.run((tx) => this.deliveries.contactFacts(tx));
    // A reminder's alert belongs to the person it is assigned to and to nobody else: an unassigned reminder
    // records NO_RECIPIENT rather than quietly re-addressing the warning to the designated contact.
    const recipient = isPreferenceGoverned(row.kind)
      ? addressee === null
        ? null
        : { address: addressee.address.toLowerCase(), label: ASSIGNEE_RECIPIENT_LABEL }
      : alertRecipientOf(contacts.dpoEmail, contacts.ownerEmails);
    if (recipient === null) {
      await this.uow.run((tx) =>
        this.deliveries.mark(tx, row.id, { status: 'SKIPPED', reason: 'NO_RECIPIENT' }),
      );
      return;
    }

    await this.send(row, recipient, contacts.name);
  }

  /**
   * The delivery history: what was raised, where it went, and what stopped it when it did not. Exists
   * because "was anybody told about this deadline" has to be answerable after the fact, by somebody who
   * did not write the record.
   */
  async list(query: ListAlertDeliveriesQueryDto): Promise<AlertDeliveryPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.deliveries.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.dsarRequestId ? { dsarRequestId: query.dsarRequestId } : {}),
        ...(query.breachId ? { breachId: query.breachId } : {}),
        ...(query.reminderId ? { reminderId: query.reminderId } : {}),
      }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  private async send(
    row: AlertDeliveryRecord,
    recipient: { address: string; label: string },
    organisationName: string,
  ): Promise<void> {
    const link = `${this.settings.appBaseUrl}${ALERT_PAGES[row.kind]}?open=${recordIdOf(row)}`;
    try {
      await this.mail.send({
        template: 'deadline-alert',
        to: recipient.address,
        link,
        organisationName,
        summary: ALERT_SUMMARIES[row.kind],
        recipientLabel: recipient.label,
      });
    } catch (error) {
      // the provider's message is stored sanitised: it never carries the record or the address
      await this.uow.run((tx) =>
        this.deliveries.mark(tx, row.id, { status: 'FAILED', error: sanitiseError(error) }),
      );
      throw error;
    }
    await this.uow.run((tx) =>
      this.deliveries.mark(tx, row.id, {
        status: 'SENT',
        recipientAddress: recipient.address,
        recipientLabel: recipient.label,
        sentAt: this.clock.now(),
      }),
    );
  }
}

/**
 * Why this alert does not go out. `ALREADY_HANDLED` and `STALE_DEADLINE` are what a re-run produces, and
 * both stay on the ledger: the row then shows that the alert was seen and recognised as one the record no
 * longer needs, instead of vanishing.
 */
function skipReasonOf(
  row: AlertDeliveryRecord,
  facts: AlertRecordFacts | null,
  addressee: AlertAddressee | null,
): AlertSkipReason | null {
  if (facts === null || facts.settled) return 'ALREADY_HANDLED';
  if (row.dueOn !== null && facts.dueOn !== row.dueOn) return 'STALE_DEADLINE';
  if (addressee !== null && !addressee.emailAllowed) return 'PREFERENCE_OFF';
  return null;
}

/**
 * The record the row names. The database CHECK guarantees exactly one of the three columns; the last term
 * only keeps this total for the type, and an alert row's own id is a legitimate page anchor if it ever
 * came to it.
 */
const recordIdOf = (row: AlertDeliveryRecord): string =>
  row.dsarRequestId ?? row.breachId ?? row.reminderId ?? row.id;

const toDto = (row: AlertDeliveryRecord): AlertDeliveryDto => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  recordId: recordIdOf(row),
  dsarRequestId: row.dsarRequestId,
  breachId: row.breachId,
  reminderId: row.reminderId,
  dueOn: row.dueOn,
  skipReason: row.skipReason,
  recipientAddress: row.recipientAddress,
  recipientLabel: row.recipientLabel,
  lastError: row.lastError,
  attempts: row.attempts,
  sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});
