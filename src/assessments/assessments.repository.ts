import { Injectable } from '@nestjs/common';
import type { AssessmentStatusValue } from './assessments.dto.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { Prisma } from '../generated/prisma/client.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface AssessmentRecord {
  id: string;
  title: string;
  description: string | null;
  status: AssessmentStatusValue;
  methodologyId: string;
  methodologyVersion: number;
  /** The band snapshot as stored: `[{ key, label, min, max }]`. Read it with `bandsOf`. */
  exposureBands: unknown;
  createdByUserId: string;
  submittedAt: Date | null;
  submittedByUserId: string | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  reviewComment: string | null;
  revisesAssessmentId: string | null;
  itemCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssessmentCreateFields {
  title: string;
  description: string | null;
  methodologyId: string;
  methodologyVersion: number;
  exposureBands: readonly object[];
  createdByUserId: string;
  revisesAssessmentId: string | null;
}

export interface AssessmentChanges {
  title?: string;
  description?: string | null;
  status?: AssessmentStatusValue;
  submittedAt?: Date | null;
  submittedByUserId?: string | null;
  approvedAt?: Date | null;
  approvedByUserId?: string | null;
  reviewComment?: string | null;
}

const SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  methodologyId: true,
  methodologyVersion: true,
  exposureBands: true,
  createdByUserId: true,
  submittedAt: true,
  submittedByUserId: true,
  approvedAt: true,
  approvedByUserId: true,
  reviewComment: true,
  revisesAssessmentId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true } },
} as const;

type Row = Omit<AssessmentRecord, 'itemCount'> & { _count: { items: number } };

const toRecord = (row: Row): AssessmentRecord => {
  const { _count, ...rest } = row;
  return { ...rest, itemCount: _count.items };
};

/** Assessments of the CURRENT organisation (see `MembershipsRepository` for the conventions). */
@Injectable()
export class AssessmentsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Oldest first (ids are UUIDv7); fetches one extra row to detect another page. */
  async list(
    tx: Tx,
    options: { limit: number; after?: string; status?: AssessmentStatusValue },
  ): Promise<AssessmentRecord[]> {
    const rows = await tx.assessment.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.status ? { status: options.status } : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  async findById(tx: Tx, id: string): Promise<AssessmentRecord | null> {
    const row = await tx.assessment.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
    return row ? toRecord(row) : null;
  }

  create(tx: Tx, fields: AssessmentCreateFields): Promise<AssessmentRecord> {
    const data: Prisma.AssessmentUncheckedCreateInput = {
      organisationId: this.organisationId,
      createdByUserId: fields.createdByUserId,
      title: fields.title,
      description: fields.description,
      methodologyId: fields.methodologyId,
      methodologyVersion: fields.methodologyVersion,
      exposureBands: fields.exposureBands as unknown as Prisma.InputJsonValue,
      revisesAssessmentId: fields.revisesAssessmentId,
    };
    return tx.assessment.create({ data, select: SELECT }).then(toRecord);
  }

  /** Version-guarded change: one row, or nothing (the caller answers `VERSION_CONFLICT`). */
  async update(tx: Tx, id: string, version: number, data: AssessmentChanges): Promise<boolean> {
    const result = await tx.assessment.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /**
   * Marks an APPROVED cycle as superseded by its revision. No `version` guard on purpose: the approval that
   * supersedes it holds the write lock on the line, and a cycle that is already superseded stays as it is.
   */
  async supersede(tx: Tx, id: string): Promise<boolean> {
    const result = await tx.assessment.updateMany({
      where: { id, organisationId: this.organisationId, status: 'APPROVED' },
      data: { status: 'SUPERSEDED', version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** The cycles that revise this one (a line, oldest first). */
  async revisionsOf(tx: Tx, assessmentId: string): Promise<AssessmentRecord[]> {
    const rows = await tx.assessment.findMany({
      where: { organisationId: this.organisationId, revisesAssessmentId: assessmentId },
      orderBy: { id: 'asc' },
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  /** Ids and item counts of the whole organisation, for the duplicate and history walks. */
  async lineageOf(tx: Tx, ids: readonly string[]): Promise<AssessmentRecord[]> {
    if (ids.length === 0) return [];
    const rows = await tx.assessment.findMany({
      where: { organisationId: this.organisationId, id: { in: [...ids] } },
      orderBy: { id: 'asc' },
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  remove(tx: Tx, id: string): Promise<{ count: number }> {
    return tx.assessment.deleteMany({ where: { id, organisationId: this.organisationId } });
  }
}
