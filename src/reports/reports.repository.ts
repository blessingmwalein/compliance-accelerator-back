import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { Prisma } from '../generated/prisma/client.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { ReportStatusValue } from './reports.dto.js';

/** A stored report: what was asked for, what was rendered, and where its bytes are. */
export interface ReportRecord {
  id: string;
  template: string;
  /** The definition version that rendered this document (1 for every report written before Phase 9a). */
  templateVersion: number;
  title: string;
  assessmentId: string | null;
  /** The parameters the report was generated with, as stored. */
  params: unknown;
  status: ReportStatusValue;
  /** The inputs actually rendered, as stored. Never returned to a client: it holds item text. */
  dataSnapshot: unknown;
  /** Null until a job has put the bytes somewhere: a PENDING row has no file to name. */
  storageKey: string | null;
  sha256: string | null;
  size: number | null;
  /** When the document became readable, or when the job gave up. */
  finishedAt: Date | null;
  errorCode: string | null;
  errorDetail: string | null;
  requestedByUserId: string;
  createdAt: Date;
}

export interface ReportCreateFields {
  id: string;
  template: string;
  templateVersion: number;
  title: string;
  assessmentId: string | null;
  params: Record<string, unknown>;
  status: ReportStatusValue;
  dataSnapshot: Record<string, unknown> | null;
  storageKey: string | null;
  sha256: string | null;
  size: number | null;
  requestedByUserId: string;
}

/** What a finished job adds to the row it was asked to fill. */
export interface ReportReadyFields {
  storageKey: string;
  sha256: string;
  size: number;
  dataSnapshot: Record<string, unknown>;
  finishedAt: Date;
}

export interface ReportFailureFields {
  errorCode: string;
  errorDetail: string;
  finishedAt: Date;
}

export interface ReportListOptions {
  limit: number;
  after?: string;
  template?: string;
  status?: ReportStatusValue;
  assessmentId?: string;
  /** Calendar days, applied as whole UTC days like every other date filter in this API. */
  from?: string;
  to?: string;
}

const SELECT = {
  id: true,
  template: true,
  templateVersion: true,
  title: true,
  assessmentId: true,
  params: true,
  status: true,
  dataSnapshot: true,
  storageKey: true,
  sha256: true,
  size: true,
  finishedAt: true,
  errorCode: true,
  errorDetail: true,
  requestedByUserId: true,
  createdAt: true,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const dayStart = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
/** The instant just after this day, so `to` covers the whole day rather than its first second. */
const dayAfter = (date: string): Date => new Date(dayStart(date).getTime() + DAY_MS);

/** Rows of `reports` for the CURRENT organisation. */
@Injectable()
export class ReportsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  create(tx: Tx, fields: ReportCreateFields): Promise<ReportRecord> {
    const data: Prisma.ReportUncheckedCreateInput = {
      id: fields.id,
      organisationId: this.organisationId,
      template: fields.template,
      templateVersion: fields.templateVersion,
      title: fields.title,
      assessmentId: fields.assessmentId,
      params: fields.params as unknown as Prisma.InputJsonValue,
      status: fields.status,
      dataSnapshot: (fields.dataSnapshot ?? undefined) as Prisma.InputJsonValue | undefined,
      storageKey: fields.storageKey,
      sha256: fields.sha256,
      size: fields.size,
      requestedByUserId: fields.requestedByUserId,
    };
    return tx.report.create({ data, select: SELECT });
  }

  /**
   * A queued report that has not been rendered yet, so its own job can fill it in. Written with the enqueue
   * and the `report.requested` audit row in one transaction: a job that points at no row is work nobody asked
   * for, and a row no job will ever fill is a report stuck at PENDING forever.
   */
  createPending(
    tx: Tx,
    fields: Omit<ReportCreateFields, 'status' | 'dataSnapshot' | 'storageKey' | 'sha256' | 'size'>,
  ): Promise<ReportRecord> {
    return this.create(tx, {
      ...fields,
      status: 'PENDING',
      dataSnapshot: null,
      storageKey: null,
      sha256: null,
      size: null,
    });
  }

  /**
   * Moves one PENDING row to READY. The guard is the status, not the clock: a job that runs twice — a lease
   * that expired while its worker was still uploading — must not rewrite a document that is already readable,
   * and the second runner gets null and discards its bytes.
   */
  async markReady(tx: Tx, id: string, ready: ReportReadyFields): Promise<ReportRecord | null> {
    const updated = await tx.report.updateMany({
      where: { id, organisationId: this.organisationId, status: 'PENDING' },
      data: {
        status: 'READY',
        storageKey: ready.storageKey,
        sha256: ready.sha256,
        size: ready.size,
        dataSnapshot: ready.dataSnapshot as unknown as Prisma.InputJsonValue,
        finishedAt: ready.finishedAt,
        errorCode: null,
        errorDetail: null,
      },
    });
    return updated.count === 0 ? null : this.findById(tx, id);
  }

  /** Gives up on a PENDING row, with the code a client branches on and the detail it shows. */
  async markFailed(tx: Tx, id: string, failure: ReportFailureFields): Promise<ReportRecord | null> {
    const updated = await tx.report.updateMany({
      where: { id, organisationId: this.organisationId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        errorCode: failure.errorCode,
        errorDetail: failure.errorDetail,
        finishedAt: failure.finishedAt,
      },
    });
    return updated.count === 0 ? null : this.findById(tx, id);
  }

  /** Newest report first: the history list is opened to find the document you generated a minute ago. */
  async list(tx: Tx, options: ReportListOptions): Promise<ReportRecord[]> {
    const occurredAt: Prisma.DateTimeFilter = {};
    if (options.from) occurredAt.gte = dayStart(options.from);
    if (options.to) occurredAt.lt = dayAfter(options.to);

    const rows = await tx.report.findMany({
      where: {
        organisationId: this.organisationId,
        ...(Object.keys(occurredAt).length > 0 ? { createdAt: occurredAt } : {}),
        ...(options.template ? { template: options.template } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.assessmentId ? { assessmentId: options.assessmentId } : {}),
        ...(options.after ? { id: { lt: options.after } } : {}),
      },
      orderBy: { id: 'desc' },
      take: options.limit + 1,
      select: SELECT,
    });
    return rows;
  }

  findById(tx: Tx, id: string): Promise<ReportRecord | null> {
    return tx.report.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
  }
}
