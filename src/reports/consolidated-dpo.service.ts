import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { BreachesService } from '../breaches/breaches.service.js';
import { ListBreachesQueryDto } from '../breaches/breaches.dto.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { isOpenDsarStatus } from '../domain/incidents/dsar.js';
import { todayIn } from '../domain/remediation/policy.js';
import { DsarService } from '../dsar/dsar.service.js';
import { ListDsarQueryDto } from '../dsar/dsar.dto.js';
import { sanitiseError } from '../jobs/backoff.js';
import type { JobContext } from '../jobs/job-handler.js';
import { LawfulBasisService } from '../lawful-basis/lawful-basis.service.js';
import { ListLawfulBasisQueryDto } from '../lawful-basis/lawful-basis.dto.js';
import {
  ListLegalHoldsQueryDto,
  ListRetentionDisposalsQueryDto,
  ListRetentionRulesQueryDto,
} from '../retention/retention.dto.js';
import { RetentionService } from '../retention/retention.service.js';
import { ListRisksQueryDto } from '../risks/risks.dto.js';
import { RisksService } from '../risks/risks.service.js';
import { ListRopaActivitiesQueryDto } from '../ropa/ropa.dto.js';
import { RopaService } from '../ropa/ropa.service.js';
import { SCORING_DISCLAIMER } from '../scoring/scoring.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StorageProvider } from '../storage/storage-provider.js';
import { RequestContext } from '../tenancy/request-context.js';
import {
  buildConsolidatedDpo,
  consolidatedDpo,
  type ConsolidatedDpoData,
  type ConsolidatedDpoParams,
  type DpoRows,
  inWindow,
  windowOf,
} from './definitions/consolidated-dpo.js';
import { renderPdf } from './pdf.renderer.js';
import { ReportsRepository, type ReportRecord } from './reports.repository.js';

/**
 * How far one section reads. A DPO document is meant to be read, so it prints a bounded number of rows of a
 * long register, and says how many it left out and whether the register held more than it read — the counts in
 * the PDF are then explainable, which is the whole point of storing a snapshot.
 */
const PAGE_SIZE = 100;
const MAX_SCAN_ROWS = 400;
const MAX_PRINTED_ROWS = 60;

/** A page of a register: the shape every module's list endpoint answers with. */
interface RowPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** The codes and the sentence a failed report carries, bounded by the columns that hold them. */
function failureOf(error: unknown): { code: string; detail: string } {
  if (error instanceof AppException) {
    return {
      code: String(error.code).slice(0, 64),
      detail: sanitiseError(error.detail ?? error.message),
    };
  }
  // A driver or renderer failure is not a sentence for a reader, and its message can carry data: the job's
  // own sanitiser is the one that knows what is safe to store.
  return { code: ErrorCode.ReportGenerationFailed, detail: sanitiseError(error) };
}

/**
 * The Consolidated DPO Report's own reader (Phase 9a). It is the one document that crosses the registers, and
 * it does so exactly as the screens do: through each module's service, never another module's repository, so a
 * PDF cannot state a number the product has not already stated.
 *
 * It runs inside a job. The row it fills was written by `ReportsService.requestConsolidatedDpo`, and the two
 * states it can leave that row in are READY with bytes, or FAILED with the code and one sentence of reason —
 * never PENDING after a settled run.
 */
@Injectable()
export class ConsolidatedDpoService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reports: ReportsRepository,
    private readonly dashboard: DashboardService,
    private readonly ropa: RopaService,
    private readonly risks: RisksService,
    private readonly lawfulBasis: LawfulBasisService,
    private readonly dsar: DsarService,
    private readonly breaches: BreachesService,
    private readonly retention: RetentionService,
    private readonly settings: SettingsService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  /**
   * Renders the report the job names. A row that is no longer PENDING was settled by an earlier run of the same
   * job, so this returns without touching it; a failure is thrown while the runner still has attempts left, and
   * only the last one writes FAILED, because a document that arrives after a retry is still the document.
   */
  async render(reportId: string, context: JobContext): Promise<void> {
    const record = await this.uow.run((tx) => this.reports.findById(tx, reportId));
    if (record === null) throw new Error('report.generate names no report in this organisation');
    // The job type is the queue's only dispatcher, and the synchronous templates are not queued: a row of
    // another template would otherwise be rendered as this one and stored under a title that does not fit it.
    if (record.template !== consolidatedDpo.id) {
      throw new Error(`report.generate cannot render the ${record.template} template`);
    }
    if (record.status !== 'PENDING') return;

    const organisationId = this.requestContext.requireOrganisationId();
    try {
      const data = await this.loadData(record);
      const bytes = await renderPdf(buildConsolidatedDpo(data));
      const storageKey = `org/${organisationId}/reports/${record.id}`;
      const stored = await this.storage.put(storageKey, bytes);
      const ready = await this.uow.run(async (tx) => {
        const updated = await this.reports.markReady(tx, record.id, {
          storageKey,
          sha256: stored.sha256,
          size: stored.size,
          dataSnapshot: snapshotOf(data),
          finishedAt: data.generatedAt,
        });
        if (updated !== null) {
          await this.audit.record(tx, {
            action: 'report.ready',
            entityType: 'report',
            entityId: updated.id,
            entityLabel: updated.title,
            changes: {
              template: consolidatedDpo.id,
              templateVersion: consolidatedDpo.version,
              period: data.window.preset,
              windowFrom: data.window.from,
              windowTo: data.window.to,
              size: stored.size,
              ...countsOf(data),
            },
          });
        }
        return updated;
      });
      if (ready === null) {
        // Another run settled it first. Its bytes are the document; ours are a copy nobody asked for.
        await this.storage.delete(storageKey).catch(() => undefined);
      }
    } catch (error) {
      if (context.attempt < context.maxAttempts) throw error;
      await this.settleFailure(record, error);
    }
  }

  /** Gives up on the row, with the code a client branches on. The audit row is written with the state change. */
  private async settleFailure(record: ReportRecord, error: unknown): Promise<void> {
    const failure = failureOf(error);
    await this.uow.run(async (tx) => {
      const failed = await this.reports.markFailed(tx, record.id, {
        errorCode: failure.code,
        errorDetail: failure.detail,
        finishedAt: this.clock.now(),
      });
      if (failed !== null) {
        await this.audit.record(tx, {
          action: 'report.failed',
          entityType: 'report',
          entityId: record.id,
          entityLabel: record.title,
          changes: {
            template: consolidatedDpo.id,
            templateVersion: consolidatedDpo.version,
            errorCode: failure.code,
          },
        });
      }
      return failed;
    });
  }

  /** Every payload the document prints, read through the service that owns it. */
  private async loadData(record: ReportRecord): Promise<ConsolidatedDpoData> {
    const params = paramsOf(record);
    const settings = await this.settings.get();
    const generatedAt = this.clock.now();
    const window = windowOf(params.period, todayIn(settings.timezone, generatedAt));

    const [
      governance,
      monitor,
      ropaRows,
      riskSummary,
      riskRows,
      bases,
      sla,
      dsarRows,
      breachSummary,
      breachRows,
      rules,
      holds,
      disposals,
    ] = await Promise.all([
      this.dashboard.summary(),
      this.ropa.monitor(),
      this.collect(
        (after) => this.ropa.list(ropaQuery(after)),
        () => true,
      ),
      this.risks.summary(),
      this.collect(
        (after) => this.risks.list(riskQuery(after)),
        (row) =>
          row.status !== 'CLOSED' ||
          inWindow(row.identifiedOn ?? row.createdAt.slice(0, 10), window),
      ),
      this.collect(
        (after) => this.lawfulBasis.list(basisQuery(after)),
        () => true,
      ),
      this.dsar.sla(),
      this.collect(
        (after) => this.dsar.list(dsarQuery(after)),
        (row) => inWindow(row.receivedOn, window) || isOpenDsarStatus(row.status),
      ),
      this.breaches.summary(),
      this.collect(
        (after) => this.breaches.list(breachQuery(after)),
        (row) => inWindow(row.detectedOn, window) || row.status !== 'CLOSED',
      ),
      this.collect(
        (after) => this.retention.listRules(ruleQuery(after)),
        () => true,
      ),
      this.collect(
        (after) => this.retention.listHolds(holdQuery(after)),
        (row) => row.active || inWindow(row.placedAt.slice(0, 10), window),
      ),
      this.collect(
        (after) => this.retention.listDisposals(disposalQuery(after)),
        (row) => inWindow(row.disposedOn, window),
      ),
    ]);

    return {
      reportId: record.id,
      organisationName: settings.name,
      timezone: settings.timezone,
      generatedAt,
      params,
      window,
      governance,
      ropa: { monitor, rows: ropaRows },
      risks: { summary: riskSummary, rows: riskRows },
      lawfulBasis: bases,
      dsar: { sla, rows: dsarRows },
      breaches: { summary: breachSummary, rows: breachRows },
      retention: { rules, holds, disposals },
      scoringDisclaimer: SCORING_DISCLAIMER,
    };
  }

  /**
   * One register, page by page through the endpoint the table itself uses, keeping the rows the window leaves
   * in and printing at most `MAX_PRINTED_ROWS` of them. The three numbers that come back are what the document
   * states, so a reader can tell a short register from a long one.
   */
  private async collect<T extends { id: string }>(
    fetch: (after: string | null) => Promise<RowPage<T>>,
    keep: (row: T) => boolean,
  ): Promise<DpoRows<T>> {
    const kept: T[] = [];
    let after: string | null = null;
    let read = 0;
    let matched = 0;
    let complete = true;
    for (;;) {
      const page = await fetch(after);
      read += page.items.length;
      for (const row of page.items) {
        if (!keep(row)) continue;
        matched += 1;
        if (kept.length < MAX_PRINTED_ROWS) kept.push(row);
      }
      if (page.nextCursor === null) break;
      if (read >= MAX_SCAN_ROWS) {
        complete = false;
        break;
      }
      after = page.nextCursor;
    }
    return { rows: kept, notPrinted: Math.max(0, matched - kept.length), complete };
  }
}

/** The stored parameters read back: the same defaults the request answered with, never a re-reading of them. */
function paramsOf(record: ReportRecord): ConsolidatedDpoParams {
  const value = (record.params ?? {}) as Record<string, unknown>;
  return {
    period:
      typeof value.period === 'string'
        ? (value.period as ConsolidatedDpoParams['period'])
        : 'last_30_days',
    confidential: value.confidential !== false,
  };
}

/** What the document drew, in the words the audit row counts on. */
function countsOf(data: ConsolidatedDpoData): Record<string, number> {
  return {
    ropaRows: data.ropa.rows.rows.length,
    riskRows: data.risks.rows.rows.length,
    basisRows: data.lawfulBasis.rows.length,
    dsarRows: data.dsar.rows.rows.length,
    breachRows: data.breaches.rows.rows.length,
    retentionRules: data.retention.rules.rows.length,
    holdRows: data.retention.holds.rows.length,
    disposalRows: data.retention.disposals.rows.length,
  };
}

/**
 * The snapshot: every payload the document printed, plus the window it printed it for. It is the answer to the
 * only question a stored PDF can be asked years later — what did the registers hold when this was drawn.
 */
function snapshotOf(data: ConsolidatedDpoData): Record<string, unknown> {
  return {
    templateVersion: consolidatedDpo.version,
    generatedAt: data.generatedAt.toISOString(),
    window: data.window,
    params: data.params,
    methodology: data.governance.exposure.methodologies,
    exposureBand: data.governance.exposure.band,
    governance: data.governance,
    ropa: data.ropa,
    risks: data.risks,
    lawfulBasis: data.lawfulBasis,
    dsar: data.dsar,
    breaches: data.breaches,
    retention: data.retention,
  };
}

const paged = <Q extends { limit?: number; after?: string }>(query: Q, after: string | null): Q => {
  query.limit = PAGE_SIZE;
  if (after !== null) query.after = after;
  return query;
};

const ropaQuery = (after: string | null): ListRopaActivitiesQueryDto =>
  paged(new ListRopaActivitiesQueryDto(), after);
const riskQuery = (after: string | null): ListRisksQueryDto =>
  paged(new ListRisksQueryDto(), after);
const basisQuery = (after: string | null): ListLawfulBasisQueryDto =>
  paged(new ListLawfulBasisQueryDto(), after);
const dsarQuery = (after: string | null): ListDsarQueryDto => paged(new ListDsarQueryDto(), after);
const breachQuery = (after: string | null): ListBreachesQueryDto =>
  paged(new ListBreachesQueryDto(), after);
const ruleQuery = (after: string | null): ListRetentionRulesQueryDto =>
  paged(new ListRetentionRulesQueryDto(), after);
const holdQuery = (after: string | null): ListLegalHoldsQueryDto =>
  paged(new ListLegalHoldsQueryDto(), after);
const disposalQuery = (after: string | null): ListRetentionDisposalsQueryDto =>
  paged(new ListRetentionDisposalsQueryDto(), after);
