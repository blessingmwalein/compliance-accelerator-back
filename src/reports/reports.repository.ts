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
  title: string;
  assessmentId: string | null;
  /** The parameters the report was generated with, as stored. */
  params: unknown;
  status: ReportStatusValue;
  /** The inputs actually rendered, as stored. Never returned to a client: it holds item text. */
  dataSnapshot: unknown;
  storageKey: string;
  sha256: string;
  size: number;
  requestedByUserId: string;
  createdAt: Date;
}

export interface ReportCreateFields {
  id: string;
  template: string;
  title: string;
  assessmentId: string | null;
  params: Record<string, unknown>;
  status: ReportStatusValue;
  dataSnapshot: Record<string, unknown>;
  storageKey: string;
  sha256: string;
  size: number;
  requestedByUserId: string;
}

const SELECT = {
  id: true,
  template: true,
  title: true,
  assessmentId: true,
  params: true,
  status: true,
  dataSnapshot: true,
  storageKey: true,
  sha256: true,
  size: true,
  requestedByUserId: true,
  createdAt: true,
} as const;

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
      title: fields.title,
      assessmentId: fields.assessmentId,
      params: fields.params as unknown as Prisma.InputJsonValue,
      status: fields.status,
      dataSnapshot: fields.dataSnapshot as unknown as Prisma.InputJsonValue,
      storageKey: fields.storageKey,
      sha256: fields.sha256,
      size: fields.size,
      requestedByUserId: fields.requestedByUserId,
    };
    return tx.report.create({ data, select: SELECT });
  }

  findById(tx: Tx, id: string): Promise<ReportRecord | null> {
    return tx.report.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
  }
}
