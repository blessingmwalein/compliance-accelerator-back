import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AssessmentItemsService } from '../assessments/assessment-items.service.js';
import { AssessmentsService } from '../assessments/assessments.service.js';
import {
  type AssessmentItemDto,
  AssessmentItemListQueryDto,
  ItemFilterQueryDto,
} from '../assessments/assessments.dto.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { uuidv7 } from '../common/uuid.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { TopRisksQueryDto } from '../dashboard/dashboard.dto.js';
import { SCORING_DISCLAIMER } from '../scoring/scoring.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StorageProvider } from '../storage/storage-provider.js';
import { RequestContext } from '../tenancy/request-context.js';
import {
  build,
  governanceAssessment,
  type GovernanceAssessmentData,
  type GovernanceAssessmentParams,
} from './definitions/governance-assessment.js';
import {
  buildExecutiveDashboard,
  executiveDashboard,
  type ExecutiveDashboardData,
} from './definitions/executive-dashboard.js';
import { renderPdf } from './pdf.renderer.js';
import type { GenerateGovernanceAssessmentDto, ReportDto, ReportParamsDto } from './reports.dto.js';
import {
  ReportsRepository,
  type ReportCreateFields,
  type ReportRecord,
} from './reports.repository.js';

/** The PDF bytes and how to name them. The storage key stays inside this service. */
export interface ReportDownload {
  readonly data: Buffer;
  readonly contentType: string;
  readonly sha256: string;
  readonly filename: string;
}

/** One page of items at a time, up to this many rows: a report that stops says that it stopped. */
const ITEM_PAGE_SIZE = 100;
const MAX_REPORT_ITEMS = 300;

const PDF_CONTENT_TYPE = 'application/pdf';

const reportNotFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Report not found.');

const bytesMissing = () =>
  new AppException(
    ErrorCode.NotFound,
    HttpStatus.NOT_FOUND,
    'The stored PDF for this report is missing.',
  );

const needActor = (actorUserId: string | undefined): string => {
  if (!actorUserId) throw new Error('Generating a report needs a signed-in actor');
  return actorUserId;
};

/** Reads the stored parameters back. A field that is not there stays `null`: nothing is invented. */
function paramsOf(stored: unknown, assessmentId: string | null): ReportParamsDto {
  const value = (stored ?? {}) as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof value[key] === 'string' ? (value[key] as string) : null;
  return {
    assessmentId: text('assessmentId') ?? assessmentId,
    businessUnitId: text('businessUnitId'),
    frameworkId: text('frameworkId'),
  };
}

const toDto = (record: ReportRecord): ReportDto => ({
  id: record.id,
  template: record.template,
  title: record.title,
  assessmentId: record.assessmentId,
  status: record.status,
  params: paramsOf(record.params, record.assessmentId),
  size: record.size,
  sha256: record.sha256,
  requestedByUserId: record.requestedByUserId,
  createdAt: record.createdAt.toISOString(),
});

/** The filter object the assessment services take, built from the report's own params. */
function summaryFilters(params: GovernanceAssessmentParams): ItemFilterQueryDto {
  const filters = new ItemFilterQueryDto();
  if (params.businessUnitId !== null) filters.businessUnitId = params.businessUnitId;
  if (params.frameworkId !== null) filters.frameworkId = params.frameworkId;
  return filters;
}

function itemPage(
  params: GovernanceAssessmentParams,
  after: string | null,
): AssessmentItemListQueryDto {
  const query = new AssessmentItemListQueryDto();
  query.limit = ITEM_PAGE_SIZE;
  if (after !== null) query.after = after;
  if (params.businessUnitId !== null) query.businessUnitId = params.businessUnitId;
  if (params.frameworkId !== null) query.frameworkId = params.frameworkId;
  return query;
}

/** The unit's name as the rows themselves report it, when a filter was applied and matched something. */
const nameOfUnit = (
  items: readonly AssessmentItemDto[],
  businessUnitId: string | null,
): string | null =>
  businessUnitId === null
    ? null
    : (items.find((item) => item.businessUnitId === businessUnitId)?.businessUnitName ?? null);

const codeOfFramework = (
  items: readonly AssessmentItemDto[],
  frameworkId: string | null,
): string | null =>
  frameworkId === null
    ? null
    : (items.find((item) => item.frameworkId === frameworkId)?.frameworkCode ?? null);

/**
 * What the document rendered, in enough detail to explain any later difference to the live screen: the
 * methodology and bands it was scored under, the roll-up, and the rows it printed.
 */
function snapshotOf(data: GovernanceAssessmentData): Record<string, unknown> {
  return {
    templateVersion: governanceAssessment.version,
    generatedAt: data.generatedAt.toISOString(),
    methodology: data.assessment.methodology,
    exposureBands: data.assessment.exposureBands,
    assessment: {
      id: data.assessment.id,
      title: data.assessment.title,
      status: data.assessment.status,
      itemCount: data.assessment.itemCount,
      submittedAt: data.assessment.submittedAt,
      approvedAt: data.assessment.approvedAt,
      reviewComment: data.assessment.reviewComment,
      revisesAssessmentId: data.assessment.revisesAssessmentId,
    },
    summary: data.summary,
    items: data.items,
    itemsOmitted: data.itemsOmitted,
  };
}

/**
 * The Executive Dashboard's snapshot: the four payloads exactly as the dashboard endpoints answered them.
 * A later screen that disagrees with this document can be compared against what was actually rendered.
 */
function executiveSnapshotOf(data: ExecutiveDashboardData): Record<string, unknown> {
  return {
    templateVersion: executiveDashboard.version,
    generatedAt: data.generatedAt.toISOString(),
    summary: data.summary,
    frameworks: data.frameworks,
    gaps: data.gaps,
    top: data.top,
  };
}

/**
 * Reports (Phase 5 core): a document rendered on the server from authorised, organisation-scoped data, stored as
 * a record with its parameters, a data snapshot and a checksum, and served back through an authorised download.
 * Data is loaded through the SAME services the API answers with, so a PDF cannot disagree with the screen it
 * was opened from (skill: reports-and-documents).
 *
 * Generation is synchronous here on purpose: one assessment cycle is a small, single-record export, which the
 * report skill allows to stream directly while still creating the record. The asynchronous catalogue, the
 * history list and the remaining templates are Phase 9a.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reports: ReportsRepository,
    private readonly assessments: AssessmentsService,
    private readonly items: AssessmentItemsService,
    private readonly dashboard: DashboardService,
    private readonly settings: SettingsService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  /** Renders the Governance Assessment of one cycle and stores it (AC-GOV-05: Export PDF is a real file). */
  async generate(dto: GenerateGovernanceAssessmentDto): Promise<ReportDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const requestedByUserId = needActor(this.requestContext.actorUserId);
    const params: GovernanceAssessmentParams = {
      assessmentId: dto.assessmentId,
      businessUnitId: dto.businessUnitId ?? null,
      frameworkId: dto.frameworkId ?? null,
    };

    // Through the API's own services: an assessment of another organisation is a 404, exactly as on screen.
    const [settings, assessment] = await Promise.all([
      this.settings.get(),
      this.assessments.get(params.assessmentId),
    ]);
    const summary = await this.assessments.summary(assessment.id, summaryFilters(params));
    const items = await this.collectItems(assessment.id, params);

    const reportId = uuidv7();
    const data: GovernanceAssessmentData = {
      reportId,
      organisationName: settings.name,
      timezone: settings.timezone,
      generatedAt: this.clock.now(),
      assessment,
      summary,
      items,
      itemsOmitted: Math.max(0, summary.itemCount - items.length),
      unitName: nameOfUnit(items, params.businessUnitId),
      frameworkCode: codeOfFramework(items, params.frameworkId),
      scoringDisclaimer: SCORING_DISCLAIMER,
    };
    const bytes = await renderPdf(build(data, params));
    return this.store({
      reportId,
      organisationId,
      requestedByUserId,
      template: governanceAssessment.id,
      title: `${governanceAssessment.title}: ${assessment.title}`,
      assessmentId: assessment.id,
      params: { ...params },
      dataSnapshot: snapshotOf(data),
      bytes,
      // The shape of the document only: an assessment carries free-text findings that can name people.
      auditChanges: {
        template: governanceAssessment.id,
        templateVersion: governanceAssessment.version,
        assessmentId: assessment.id,
        items: items.length,
      },
    });
  }

  /**
   * Renders the Executive Dashboard (Phase 8) and stores it: the organisation-wide figures, the framework
   * comparison, the gap list and the highest-exposure risks, as of the day the document is drawn.
   *
   * The data is read through the dashboard's own service, so the PDF carries the numbers the screen shows.
   * The basis is the residual one the register defaults to, and the top list the default length: a document
   * that let the caller re-rank the same risks would be a second way to state them.
   */
  async generateExecutiveDashboard(): Promise<ReportDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const requestedByUserId = needActor(this.requestContext.actorUserId);

    const [settings, summary, frameworks, gaps, top] = await Promise.all([
      this.settings.get(),
      this.dashboard.summary(),
      this.dashboard.frameworks(),
      this.dashboard.gapAnalysis(),
      this.dashboard.topRisks(new TopRisksQueryDto()),
    ]);

    const reportId = uuidv7();
    const data: ExecutiveDashboardData = {
      reportId,
      organisationName: settings.name,
      generatedAt: this.clock.now(),
      summary,
      frameworks,
      gaps,
      top,
      scoringDisclaimer: SCORING_DISCLAIMER,
    };
    const bytes = await renderPdf(buildExecutiveDashboard(data));
    return this.store({
      reportId,
      organisationId,
      requestedByUserId,
      template: executiveDashboard.id,
      title: `${executiveDashboard.title}: ${settings.name}`,
      assessmentId: null,
      params: {},
      dataSnapshot: executiveSnapshotOf(data),
      bytes,
      // Titles and names stay out of the audit row: it records what was drawn, not what was drawn of.
      auditChanges: {
        template: executiveDashboard.id,
        templateVersion: executiveDashboard.version,
        asOf: summary.asOf,
        frameworks: frameworks.frameworks.length,
        gapRows: gaps.rows.length,
        topRisks: top.items.length,
      },
    });
  }

  /**
   * Puts the rendered bytes in private storage and writes the record with its snapshot and checksum, in one
   * transaction with the audit row. A failed write removes the file again: an orphaned PDF nobody can name
   * is data left behind.
   */
  private async store(input: {
    readonly reportId: string;
    readonly organisationId: string;
    readonly requestedByUserId: string;
    readonly template: string;
    readonly title: string;
    readonly assessmentId: string | null;
    readonly params: Record<string, unknown>;
    readonly dataSnapshot: Record<string, unknown>;
    readonly bytes: Buffer;
    readonly auditChanges: Record<string, unknown>;
  }): Promise<ReportDto> {
    const storageKey = `org/${input.organisationId}/reports/${input.reportId}`;
    const stored = await this.storage.put(storageKey, input.bytes);
    let record: ReportRecord;
    try {
      record = await this.uow.run(async (tx) => {
        const created = await this.reports.create(tx, {
          id: input.reportId,
          template: input.template,
          title: input.title,
          assessmentId: input.assessmentId,
          params: input.params,
          status: 'READY',
          dataSnapshot: input.dataSnapshot,
          storageKey,
          sha256: stored.sha256,
          size: stored.size,
          requestedByUserId: input.requestedByUserId,
        } satisfies ReportCreateFields);
        await this.audit.record(tx, {
          action: 'report.generated',
          entityType: 'report',
          entityId: created.id,
          entityLabel: created.title,
          changes: { ...input.auditChanges, size: stored.size },
        });
        return created;
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
    return toDto(record);
  }

  /** The record as stored: what was asked for, when it was ready, and how big the file is. */
  async get(id: string): Promise<ReportDto> {
    return this.uow.run(async (tx) => {
      const record = await this.reports.findById(tx, id);
      if (!record) throw reportNotFound();
      return toDto(record);
    });
  }

  /**
   * The PDF itself, proxied through this authorised endpoint by someone who may read reports: there is no
   * public URL for one. The download is audited in the same transaction as the lookup, then the bytes are read.
   */
  async download(id: string): Promise<ReportDownload> {
    const record = await this.uow.run(async (tx) => {
      const found = await this.reports.findById(tx, id);
      if (!found) throw reportNotFound();
      await this.audit.record(tx, {
        action: 'report.downloaded',
        entityType: 'report',
        entityId: found.id,
        entityLabel: found.title,
      });
      return found;
    });
    // Outside the transaction: a storage read is not database work, and the Neon pooler wants short ones.
    const data = await this.storage.get(record.storageKey);
    if (!data) throw bytesMissing();
    return {
      data,
      contentType: PDF_CONTENT_TYPE,
      sha256: record.sha256,
      filename: `${record.template.replace(/_/g, '-')}-${record.id}.pdf`,
    };
  }

  /**
   * Every item the filters leave, page by page through the same list the table uses, up to `MAX_REPORT_ITEMS`.
   * What is left out is counted and named in the document, never dropped in silence.
   */
  private async collectItems(
    assessmentId: string,
    params: GovernanceAssessmentParams,
  ): Promise<AssessmentItemDto[]> {
    const collected: AssessmentItemDto[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.items.list(assessmentId, itemPage(params, after));
      collected.push(...page.items);
      if (page.nextCursor === null || collected.length >= MAX_REPORT_ITEMS) {
        return collected.slice(0, MAX_REPORT_ITEMS);
      }
      after = page.nextCursor;
    }
  }
}
