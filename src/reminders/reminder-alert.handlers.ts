import { Injectable } from '@nestjs/common';
import { ALERT_JOB_TYPES, type AlertJobPayload } from '../alerts/alert-jobs.js';
import {
  AlertsService,
  type AlertAddressee,
  type AlertRecordFacts,
} from '../alerts/alerts.service.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import {
  isPreferenceGoverned,
  preferenceFieldFor,
  type AlertKind,
} from '../domain/incidents/alerts.js';
import {
  REMINDER_PREFERENCE_DEFAULTS,
  type ReminderPreferenceField,
} from '../domain/incidents/reminders.js';
import { JobHandler, type JobHandlerContract } from '../jobs/job-handler.js';
import { RemindersRepository } from './reminders.repository.js';

function parse(payload: unknown): AlertJobPayload {
  const { organisationId, alertId } = (payload ?? {}) as Partial<AlertJobPayload>;
  if (typeof organisationId !== 'string' || organisationId.length === 0) {
    throw new Error('Malformed job payload: organisationId missing');
  }
  if (typeof alertId !== 'string' || alertId.length === 0) {
    throw new Error('Malformed job payload: alertId missing');
  }
  return { organisationId, alertId };
}

/** What the reminder still says, and who this alert may go to. */
interface SendFacts {
  facts: AlertRecordFacts | null;
  addressee: AlertAddressee | null;
}

/**
 * The two reminder thresholds (AC-REMD-01). The job payload carries the tenant and the ledger row and
 * nothing else, so everything is re-read here, at send time, in one short transaction that commits before
 * the message leaves the process.
 *
 * A settled reminder and a missing one both end up as a SKIPPED row, and so does a member who switched this
 * threshold off — the row stays as the proof that the alert was seen and recognised, never as a silent
 * nothing.
 */
abstract class ReminderAlertHandler implements JobHandlerContract {
  protected constructor(
    /** Which threshold this handler owns: it names the preference field that governs it. */
    protected readonly kind: AlertKind,
    private readonly uow: UnitOfWork,
    private readonly reminders: RemindersRepository,
    private readonly alerts: AlertsService,
  ) {}

  async handle(payload: unknown): Promise<void> {
    const { alertId } = parse(payload);
    // `isPreferenceGoverned` is the reason there are only two reminder handlers: a reminder's own alerts are
    // the only ones a member's email choices can reach. An alert an incident raises to the designated
    // contact is not a preference, and no setting in this module can silence it.
    const field = preferenceFieldFor(this.kind);
    if (field === null || !isPreferenceGoverned(this.kind)) {
      throw new Error(`No member preference governs the "${this.kind}" alert`);
    }
    const send = await this.uow.run((tx) => this.readFacts(tx, alertId, field));
    await this.alerts.deliver({ alertId, facts: send.facts, addressee: send.addressee });
  }

  private async readFacts(
    tx: Tx,
    alertId: string,
    field: ReminderPreferenceField,
  ): Promise<SendFacts> {
    const reminderId = await this.reminders.findAlertReminderId(tx, alertId);
    const reminder =
      reminderId === null ? null : await this.reminders.findAlertState(tx, reminderId);
    // the reminder is gone: `facts: null` records that, rather than sending about a date nobody owns
    if (reminder === null) return { facts: null, addressee: null };

    const facts: AlertRecordFacts = {
      settled: reminder.status !== 'PENDING',
      dueOn: reminder.dueOn,
    };
    const membershipId = reminder.assigneeMembershipId;
    const assignee =
      membershipId === null ? null : await this.reminders.findAlertAssignee(tx, membershipId);
    // no assignee is no person to tell; the ledger records `NO_RECIPIENT` instead of inventing one
    if (assignee === null) return { facts, addressee: null };

    const preference = await this.reminders.findPreference(tx, assignee.id);
    return {
      facts,
      addressee: {
        address: assignee.email,
        // no row means the default, which is on: a member who never opened the settings page still hears
        // about their own overdue work
        emailAllowed: preference?.[field] ?? REMINDER_PREFERENCE_DEFAULTS[field],
      },
    };
  }
}

@Injectable()
@JobHandler(ALERT_JOB_TYPES.REMINDER_DUE_SOON)
export class ReminderDueSoonAlertHandler extends ReminderAlertHandler {
  constructor(uow: UnitOfWork, reminders: RemindersRepository, alerts: AlertsService) {
    super('REMINDER_DUE_SOON', uow, reminders, alerts);
  }
}

@Injectable()
@JobHandler(ALERT_JOB_TYPES.REMINDER_OVERDUE)
export class ReminderOverdueAlertHandler extends ReminderAlertHandler {
  constructor(uow: UnitOfWork, reminders: RemindersRepository, alerts: AlertsService) {
    super('REMINDER_OVERDUE', uow, reminders, alerts);
  }
}
