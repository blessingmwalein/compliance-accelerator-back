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
import { pageSizeOf, toPage } from '../common/pagination.js';
import { uuidv7 } from '../common/uuid.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { TopRisksQueryDto } from '../dashboard/dashboard.dto.js';
import { JobsService } from '../jobs/jobs.service.js';
import { ListRopaActivitiesQueryDto, type RopaActivityDto } from '../ropa/ropa.dto.js';
import { RopaService } from '../ropa/ropa.service.js';
import { SCORING_DISCLAIMER } from '../scoring/scoring.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StorageProvider } from '../storage/storage-provider.js';
import { RequestContext } from '../tenancy/request-context.js';
import {
  PLANNED_REPORT_TEMPLATES,
  REPORT_PERMISSIONS,
  REPORT_TEMPLATES,
  type ReportTemplateDefinition,
} from './definitions/registry.js';
import { consolidatedDpo, type ConsolidatedDpoParams } from './definitions/consolidated-dpo.js';
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
import {
  buildRopaRegister,
  ropaRegister,
  type RopaRegisterData,
} from './definitions/ropa-register.js';
import { REPORT_JOB_TYPES } from './report-jobs.js';
import { renderPdf } from './pdf.renderer.js';
import {
  DEFAULT_DPO_PERIOD,
  DPO_PERIODS,
  type DpoPeriodValue,
  type GenerateConsolidatedDpoDto,
  type GenerateGovernanceAssessmentDto,
  type ListReportsQueryDto,
  type ReportCatalogueDto,
  type ReportDto,
  type ReportPageDto,
  type ReportParamsDto,
  type ReportTemplateParamDto,
} from './reports.dto.js';
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

/** The register is read the same way: page by page, and a document that stops says that it stopped. */
const REGISTER_PAGE_SIZE = 100;
const MAX_REGISTER_ROWS = 300;

const PDF_CONTENT_TYPE = 'application/pdf';

const reportNotFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Report not found.');

const bytesMissing = () =>
  new AppException(
    ErrorCode.NotFound,
    HttpStatus.NOT_FOUND,
    'The stored PDF for this report is missing.',
  );

/**
 * A document that has not been drawn yet, or that a job gave up on. It is a conflict rather than a not-found:
 * the record exists and the client is polling it, so the reason belongs in the answer.
 */
const notDownloadable = (status: string) =>
  new AppException(
    ErrorCode.Conflict,
    HttpStatus.CONFLICT,
    status === 'PENDING'
      ? 'This report is still being generated. Read its record, then download it when it is READY.'
      : 'This report did not finish. Its record carries the reason.',
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
  const period = text('period');
  return {
    assessmentId: text('assessmentId') ?? assessmentId,
    businessUnitId: text('businessUnitId'),
    frameworkId: text('frameworkId'),
    period:
      period !== null && (DPO_PERIODS as readonly string[]).includes(period)
        ? (period as DpoPeriodValue)
        : null,
    confidential: typeof value.confidential === 'boolean' ? value.confidential : null,
  };
}

const toDto = (record: ReportRecord): ReportDto => ({
  id: record.id,
  template: record.template,
  templateVersion: record.templateVersion,
  title: record.title,
  assessmentId: record.assessmentId,
  status: record.status,
  params: paramsOf(record.params, record.assessmentId),
  size: record.size,
  sha256: record.sha256,
  finishedAt: record.finishedAt?.toISOString() ?? null,
  errorCode: record.errorCode,
  errorDetail: record.errorDetail,
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

/** The catalogue's wording of one parameter: the optional fields become the nulls the contract states. */
function paramOf(param: ReportTemplateDefinition['params'][number]): ReportTemplateParamDto {
  return {
    name: param.name,
    type: param.type,
    required: param.required,
    description: param.description,
    values: param.values ?? null,
    default: param.default ?? null,
  };
}

/**
 * Reports (Phase 5 core, catalogue and history in 9a): a document rendered on the server from authorised,
 * organisation-scoped data, stored as a record with its parameters, a data snapshot and a checksum, and served
 * back through an authorised download. Data is loaded through the SAME services the API answers with, so a PDF
 * cannot disagree with the screen it was opened from (skill: reports-and-documents).
 *
 * The three documents of Phases 5, 8 and 9 stay synchronous: one cycle, one dashboard and one standing register
 * are small reads, which the report rules allow to be drawn in the request while still creating the record. The
 * Consolidated DPO Report is asynchronous — a period can span seven registers, so it answers 202 with a
 * PENDING row and a job fills it in (see `ConsolidatedDpoService`).
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reports: ReportsRepository,
    private readonly assessments: AssessmentsService,
    private readonly items: AssessmentItemsService,
    private readonly dashboard: DashboardService,
    private readonly ropa: RopaService,
    private readonly settings: SettingsService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
    private readonly jobs: JobsService,
  ) {}

  /**
   * What this build can render, and what a later phase will: the generate screen is built from it, so a
   * template's title, version, parameters and mode exist in exactly one place — the definitions themselves.
   */
  catalogue(): ReportCatalogueDto {
    return {
      items: REPORT_TEMPLATES.map((template) => ({
        template: template.id,
        version: template.version,
        title: template.title,
        description: template.description,
        generate: template.generate,
        permission: REPORT_PERMISSIONS.export,
        params: template.params.map(paramOf),
      })),
      planned: PLANNED_REPORT_TEMPLATES.map((template) => ({
        template: template.id,
        title: template.title,
        phase: template.phase,
      })),
    };
  }

  /** The history list: every report this organisation asked for, newest first, whatever its state. */
  async list(query: ListReportsQueryDto): Promise<ReportPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.reports.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.template ? { template: query.template } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.assessmentId ? { assessmentId: query.assessmentId } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

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
      templateVersion: governanceAssessment.version,
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
   * Renders and stores the Executive Dashboard (Phase 8): the organisation-wide figures, the framework
   * comparison, the gap list and the highest-exposure risks. There is nothing to send: the document covers the
   * whole organisation, as of the day it is drawn, from the same payloads the dashboard screen reads.
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
      templateVersion: executiveDashboard.version,
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
   * Renders and stores the Record of Processing Activities (article 30): every live activity with the lawful
   * basis that justifies it, the classification it carries and the review it is owed. There is nothing to send —
   * the document is the register as it stands on the day it is drawn.
   *
   * The data comes from `RopaService`, the same service the RoPA page reads, including its monitor counts, so
   * the four figures on the PDF are the four cards on the screen. One request holds at most
   * `MAX_REGISTER_ROWS` activities; the document states what it left out.
   */
  async generateRopaRegister(): Promise<ReportDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const requestedByUserId = needActor(this.requestContext.actorUserId);

    const [settings, monitor] = await Promise.all([this.settings.get(), this.ropa.monitor()]);
    const rows = await this.collectRegister();

    const reportId = uuidv7();
    const data: RopaRegisterData = {
      reportId,
      organisationName: settings.name,
      timezone: settings.timezone,
      generatedAt: this.clock.now(),
      monitor,
      rows,
      rowsOmitted: Math.max(0, monitor.total - rows.length),
      scoringDisclaimer: SCORING_DISCLAIMER,
    };
    const bytes = await renderPdf(buildRopaRegister(data));
    return this.store({
      reportId,
      organisationId,
      requestedByUserId,
      template: ropaRegister.id,
      templateVersion: ropaRegister.version,
      title: `${ropaRegister.title}: ${settings.name}`,
      assessmentId: null,
      params: {},
      dataSnapshot: {
        templateVersion: ropaRegister.version,
        generatedAt: data.generatedAt.toISOString(),
        monitor: data.monitor,
        rows: data.rows,
        rowsOmitted: data.rowsOmitted,
      },
      bytes,
      // What was drawn, not what was drawn of: a register line names people and processing.
      auditChanges: {
        template: ropaRegister.id,
        templateVersion: ropaRegister.version,
        asOf: monitor.asOf,
        activities: rows.length,
        rowsOmitted: data.rowsOmitted,
      },
    });
  }

  /**
   * The register, page by page through the endpoint the table itself uses, so the PDF and the screen read the
   * same rows in the same order. `RopaService.list` excludes archived activities unless asked for them, which is
   * exactly what a document of the standing register wants.
   */
  private async collectRegister(): Promise<RopaActivityDto[]> {
    const collected: RopaActivityDto[] = [];
    let after: string | null = null;
    for (;;) {
      const query = new ListRopaActivitiesQueryDto();
      query.limit = REGISTER_PAGE_SIZE;
      if (after !== null) query.after = after;
      const page = await this.ropa.list(query);
      collected.push(...page.items);
      if (page.nextCursor === null || collected.length >= MAX_REGISTER_ROWS) {
        return collected.slice(0, MAX_REGISTER_ROWS);
      }
      after = page.nextCursor;
    }
  }

  /**
   * Asks for the Consolidated DPO Report (Phase 9a): the record is written and the job enqueued in one
   * transaction, and the answer is the PENDING row the client polls. Nothing is rendered here — the period can
   * cover seven registers, which is more work than a request should hold the connection for.
   */
  async requestConsolidatedDpo(dto: GenerateConsolidatedDpoDto): Promise<ReportDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const requestedByUserId = needActor(this.requestContext.actorUserId);
    const settings = await this.settings.get();
    const params: ConsolidatedDpoParams = {
      period: dto.period ?? DEFAULT_DPO_PERIOD,
      confidential: dto.confidential ?? true,
    };
    const reportId = uuidv7();

    const record = await this.uow.run(async (tx) => {
      const created = await this.reports.createPending(tx, {
        id: reportId,
        template: consolidatedDpo.id,
        templateVersion: consolidatedDpo.version,
        title: `${consolidatedDpo.title}: ${settings.name}`,
        assessmentId: null,
        params: { ...params },
        requestedByUserId,
      });
      // The job and the row commit together: a job for a report nobody asked for, or a report no job will
      // ever fill, are both states a reader cannot tell apart from slow work.
      await this.jobs.enqueue(
        {
          type: REPORT_JOB_TYPES.generate,
          payload: { organisationId, reportId },
          dedupeKey: `report-generate:${reportId}`,
        },
        tx,
      );
      await this.audit.record(tx, {
        action: 'report.requested',
        entityType: 'report',
        entityId: created.id,
        entityLabel: created.title,
        changes: {
          template: consolidatedDpo.id,
          templateVersion: consolidatedDpo.version,
          period: params.period,
          confidential: params.confidential,
        },
      });
      return created;
    });
    return toDto(record);
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
    readonly templateVersion: number;
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
          templateVersion: input.templateVersion,
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

  /** The record as stored: what was asked for, which state it is in, and how big the file is once there is one. */
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
    // A queued or failed row has no bytes to name, and its record says why; only READY ones do.
    if (record.status !== 'READY') throw notDownloadable(record.status);
    const { storageKey, sha256 } = record;
    if (storageKey === null || sha256 === null) throw bytesMissing();
    // Outside the transaction: a storage read is not database work, and the Neon pooler wants short ones.
    const data = await this.storage.get(storageKey);
    if (!data) throw bytesMissing();
    return {
      data,
      contentType: PDF_CONTENT_TYPE,
      sha256,
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
