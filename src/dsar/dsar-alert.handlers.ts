import { Injectable } from '@nestjs/common';
import { ALERT_JOB_TYPES, type AlertJobPayload } from '../alerts/alert-jobs.js';
import { AlertsService, type AlertRecordFacts } from '../alerts/alerts.service.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { isTerminalDsarStatus } from '../domain/incidents/dsar.js';
import { toDateOnly } from '../domain/registers/review.js';
import { JobHandler, type JobHandlerContract } from '../jobs/job-handler.js';
import { DsarRepository } from './dsar.repository.js';

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

/**
 * The two data subject request thresholds (AC-DSAR-02). The payload carries the tenant and the ledger row
 * and nothing else, so nothing about the data subject is read from it: the request is re-read here, in one
 * short transaction that closes before the message leaves the process, because a job runs at least once.
 *
 * A request that has since been completed, refused or withdrawn makes this alert `ALREADY_HANDLED`, and one
 * whose deadline has moved on an extension makes it `STALE_DEADLINE`. Both stay on the ledger as the proof
 * that the re-run was recognised rather than obeyed; neither is deleted and neither is sent.
 */
abstract class DsarAlertHandler implements JobHandlerContract {
  protected constructor(
    private readonly uow: UnitOfWork,
    private readonly dsar: DsarRepository,
    private readonly alerts: AlertsService,
  ) {}

  async handle(payload: unknown): Promise<void> {
    const { alertId } = parse(payload);
    const facts = await this.uow.run((tx) => this.readFacts(tx, alertId));
    await this.alerts.deliver({ alertId, facts });
  }

  /**
   * The delivery row belongs to the alerts module, so the request is found through this model's own
   * relation to it rather than by reading another module's table.
   */
  private async readFacts(tx: Tx, alertId: string): Promise<AlertRecordFacts | null> {
    const record = await this.dsar.findByAlertId(tx, alertId);
    // no request behind the alert: `facts: null` records that instead of sending about a date nobody owns
    if (record === null) return null;
    return { settled: isTerminalDsarStatus(record.status), dueOn: toDateOnly(record.dueOn) };
  }
}

@Injectable()
@JobHandler(ALERT_JOB_TYPES.DSAR_DUE_SOON)
export class DsarDueSoonAlertHandler extends DsarAlertHandler {
  constructor(uow: UnitOfWork, dsar: DsarRepository, alerts: AlertsService) {
    super(uow, dsar, alerts);
  }
}

@Injectable()
@JobHandler(ALERT_JOB_TYPES.DSAR_OVERDUE)
export class DsarOverdueAlertHandler extends DsarAlertHandler {
  constructor(uow: UnitOfWork, dsar: DsarRepository, alerts: AlertsService) {
    super(uow, dsar, alerts);
  }
}
