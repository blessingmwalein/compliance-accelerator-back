import { Injectable } from '@nestjs/common';
import { AlertsService, type AlertRecordFacts } from '../alerts/alerts.service.js';
import { ALERT_JOB_TYPES, type AlertJobPayload } from '../alerts/alert-jobs.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type { BreachNotificationState, BreachStatus } from '../domain/incidents/breach.js';
import type { RiskLevel } from '../domain/scoring/methodologies.js';
import { toDateOnly } from '../domain/registers/review.js';
import { JobHandler, type JobHandlerContract } from '../jobs/job-handler.js';
import type { BreachAggregateRow } from './breaches.repository.js';
import { BreachesRepository } from './breaches.repository.js';

/**
 * What a breach alert still has to say about itself. The payload carries ids only (ADR-0006, AC-BRC-02):
 * the breach is re-read here, at send time, because a job runs at least once and the record may have been
 * closed, decided or re-dated since the alert was queued.
 */
function alertIdOf(payload: unknown): string {
  const value = (payload ?? {}) as Partial<AlertJobPayload>;
  if (typeof value.organisationId !== 'string' || value.organisationId.length === 0) {
    throw new Error('Malformed alert job payload: organisationId missing');
  }
  if (typeof value.alertId !== 'string' || value.alertId.length === 0) {
    throw new Error('Malformed alert job payload: alertId missing');
  }
  return value.alertId;
}

/** The three breach columns a `settled` answer is made of, with nothing personal beside them. */
interface BreachDuty {
  status: BreachStatus;
  notificationState: BreachNotificationState;
  severity: RiskLevel | null;
  assessmentDueOn: string | null;
  notificationDueOn: string | null;
}

/**
 * The breach alerts (AC-BRC-02). One handler per job type, each answering one question about the record
 * and handing it to `AlertsService.deliver`, which decides whether the mail goes out, is skipped, or has
 * already been sent. Nothing here writes a breach, an alert row or an email address.
 */
abstract class BreachAlertHandler implements JobHandlerContract {
  protected constructor(
    private readonly uow: UnitOfWork,
    private readonly breaches: BreachesRepository,
    private readonly alerts: AlertsService,
  ) {}

  async handle(payload: unknown): Promise<void> {
    const alertId = alertIdOf(payload);
    const duty = await this.uow.run((tx) => this.readDuty(tx, alertId));
    // a record this module cannot read at all is a record that no longer needs telling about
    await this.alerts.deliver({ alertId, facts: duty === null ? null : this.factsOf(duty) });
  }

  /** The delivery row names the breach; the payload names only the delivery. */
  private async readDuty(tx: Tx, alertId: string): Promise<BreachDuty | null> {
    const breachId = await this.breaches.breachIdOfAlert(tx, alertId);
    if (breachId === null) return null;
    const row = await this.breaches.forAlert(tx, breachId);
    return row === null ? null : toDuty(row);
  }

  protected abstract factsOf(duty: BreachDuty): AlertRecordFacts;
}

const toDuty = (row: BreachAggregateRow): BreachDuty => ({
  status: row.status,
  notificationState: row.notificationState,
  severity: row.severity,
  assessmentDueOn: toDateOnly(row.assessmentDueOn),
  notificationDueOn: toDateOnly(row.notificationDueOn),
});

/** Told as the breach is recorded: it stops being news once the record is closed. */
@Injectable()
@JobHandler(ALERT_JOB_TYPES.BREACH_RECORDED)
export class BreachRecordedAlertHandler extends BreachAlertHandler {
  constructor(uow: UnitOfWork, breaches: BreachesRepository, alerts: AlertsService) {
    super(uow, breaches, alerts);
  }

  protected factsOf(duty: BreachDuty): AlertRecordFacts {
    return { settled: duty.status === 'CLOSED', dueOn: null };
  }
}

/**
 * The assessment duty. The record shows the assessment was made when a person stated its severity, or
 * when the duty the assessment feeds has already been decided; until then there is no other column that
 * says the work was done, so nothing else settles this alert.
 */
@Injectable()
@JobHandler(ALERT_JOB_TYPES.BREACH_ASSESSMENT_DUE)
export class BreachAssessmentDueAlertHandler extends BreachAlertHandler {
  constructor(uow: UnitOfWork, breaches: BreachesRepository, alerts: AlertsService) {
    super(uow, breaches, alerts);
  }

  protected factsOf(duty: BreachDuty): AlertRecordFacts {
    const assessed = duty.severity !== null || duty.notificationState !== 'UNDECIDED';
    return {
      settled: duty.status === 'CLOSED' || assessed,
      dueOn: duty.assessmentDueOn,
    };
  }
}

/** The notification duty: answered by a decision, not by a fix. */
@Injectable()
@JobHandler(ALERT_JOB_TYPES.BREACH_NOTIFICATION_DUE)
export class BreachNotificationDueAlertHandler extends BreachAlertHandler {
  constructor(uow: UnitOfWork, breaches: BreachesRepository, alerts: AlertsService) {
    super(uow, breaches, alerts);
  }

  protected factsOf(duty: BreachDuty): AlertRecordFacts {
    return {
      settled: duty.notificationState !== 'UNDECIDED' || duty.status === 'CLOSED',
      dueOn: duty.notificationDueOn,
    };
  }
}
