import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import {
  TERMINAL_DSAR_STATUSES,
  type DsarCommunicationKind,
  type DsarIdentityState,
  type DsarRequestType,
  type DsarStatus,
} from '../domain/incidents/dsar.js';
import type { EvidenceReviewStatus } from '../domain/incidents/evidence.js';
import { RequestContext } from '../tenancy/request-context.js';

/** A data subject request with the names of what it points at, as the API shows it. */
export interface DsarRecord {
  id: string;
  requestType: DsarRequestType;
  summary: string | null;
  subjectName: string | null;
  subjectEmail: string | null;
  status: DsarStatus;
  identityState: DsarIdentityState;
  businessUnitId: string | null;
  businessUnitName: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  identityVerifiedOn: Date | null;
  identityVerifiedByUserId: string | null;
  identityNote: string | null;
  /** The frozen policy numbers and the dates they produced. Nothing here is recomputed from today. */
  policyId: string | null;
  responseDays: number | null;
  baseDueOn: Date | null;
  dueOn: Date | null;
  extensionDays: number;
  extensionCount: number;
  closureNote: string | null;
  completedOn: Date | null;
  completedByUserId: string | null;
  /** DATE columns: UTC-midnight Dates whose UTC day is the calendar day. */
  receivedOn: Date;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  createdByUserId: string;
}

/** What a write may put on a request row. Split so a service cannot send a column it does not own. */
export interface DsarContentChanges {
  requestType?: DsarRequestType;
  summary?: string | null;
  subjectName?: string | null;
  subjectEmail?: string | null;
  businessUnitId?: string | null;
  ownerMembershipId?: string | null;
}

export interface DsarNewRequest extends DsarContentChanges {
  requestType: DsarRequestType;
  receivedOn: Date;
  policyId: string | null;
  responseDays: number | null;
  baseDueOn: Date | null;
  dueOn: Date | null;
}

export type DsarChanges = DsarContentChanges & {
  status?: DsarStatus;
  closureNote?: string | null;
  completedOn?: Date | null;
  completedByUserId?: string | null;
  identityState?: DsarIdentityState;
  identityVerifiedOn?: Date | null;
  identityVerifiedByUserId?: string | null;
  identityNote?: string | null;
  dueOn?: Date;
  extensionDays?: number;
  extensionCount?: number;
};

export interface DsarCommunicationRecord {
  id: string;
  kind: DsarCommunicationKind;
  occurredOn: Date;
  note: string;
  createdByUserId: string;
  createdAt: Date;
}

/** An evidence file attached to a request, read through the link row. */
export interface DsarEvidenceRecord {
  evidenceId: string;
  title: string;
  reviewStatus: EvidenceReviewStatus;
  currentVersion: number;
  linkedByUserId: string;
  linkedAt: Date;
}

/** The columns the SLA is counted from. */
export interface DsarSlaRow {
  status: DsarStatus;
  dueOn: Date | null;
  completedOn: Date | null;
}

/** What an alert may still be told about its record, re-read at send time. */
export interface DsarAlertRecord {
  id: string;
  status: DsarStatus;
  dueOn: Date | null;
}

export interface ListDsarOptions {
  limit: number;
  after?: string;
  q?: string;
  status?: DsarStatus;
  requestType?: DsarRequestType;
  identityState?: DsarIdentityState;
  /** Only requests due on or before this calendar day (`YYYY-MM-DD`). */
  dueBefore?: string;
  excludeClosed?: boolean;
}

const SELECT = {
  id: true,
  requestType: true,
  summary: true,
  subjectName: true,
  subjectEmail: true,
  status: true,
  identityState: true,
  businessUnitId: true,
  ownerMembershipId: true,
  identityVerifiedOn: true,
  identityVerifiedByUserId: true,
  identityNote: true,
  policyId: true,
  responseDays: true,
  baseDueOn: true,
  dueOn: true,
  extensionDays: true,
  extensionCount: true,
  closureNote: true,
  completedOn: true,
  completedByUserId: true,
  receivedOn: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  createdByUserId: true,
  businessUnit: { select: { name: true } },
  owner: { select: { user: { select: { fullName: true } } } },
} as const;

type DsarRow = {
  businessUnit: { name: string } | null;
  owner: { user: { fullName: string } } | null;
} & Omit<DsarRecord, 'businessUnitName' | 'ownerName'>;

const toRecord = (row: DsarRow): DsarRecord => {
  const { businessUnit, owner, ...rest } = row;
  return {
    ...rest,
    businessUnitName: businessUnit?.name ?? null,
    ownerName: owner?.user.fullName ?? null,
  };
};

const COMMUNICATION_SELECT = {
  id: true,
  kind: true,
  occurredOn: true,
  note: true,
  createdByUserId: true,
  createdAt: true,
} as const;

const EVIDENCE_LINK_SELECT = {
  evidenceId: true,
  linkedByUserId: true,
  linkedAt: true,
  evidence: {
    select: { id: true, title: true, reviewStatus: true, currentVersion: true },
  },
} as const;

type EvidenceLinkRow = {
  evidenceId: string;
  linkedByUserId: string;
  linkedAt: Date;
  evidence: {
    id: string;
    title: string;
    reviewStatus: EvidenceReviewStatus;
    currentVersion: number;
  };
};

const toEvidence = (row: EvidenceLinkRow): DsarEvidenceRecord => ({
  evidenceId: row.evidence.id,
  title: row.evidence.title,
  reviewStatus: row.evidence.reviewStatus,
  currentVersion: row.evidence.currentVersion,
  linkedByUserId: row.linkedByUserId,
  linkedAt: row.linkedAt,
});

/**
 * The data subject requests of the CURRENT organisation, in creation order (ids are UUIDv7). The deadline
 * columns are written once, from the policy in force at the time, and no method here reads the policy: a
 * later change to it cannot move a date this row already carries.
 */
@Injectable()
export class DsarRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  async list(tx: Tx, options: ListDsarOptions): Promise<DsarRecord[]> {
    const rows = await tx.dsarRequest.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.status ? { status: options.status } : {}),
        ...(options.requestType ? { requestType: options.requestType } : {}),
        ...(options.identityState ? { identityState: options.identityState } : {}),
        ...(options.dueBefore
          ? { dueOn: { lte: new Date(`${options.dueBefore}T00:00:00.000Z`) } }
          : {}),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.excludeClosed && !options.status
          ? { status: { notIn: [...TERMINAL_DSAR_STATUSES] } }
          : {}),
        ...(options.q
          ? {
              OR: [
                { summary: { contains: options.q, mode: 'insensitive' as const } },
                { subjectName: { contains: options.q, mode: 'insensitive' as const } },
                { subjectEmail: { contains: options.q, mode: 'insensitive' as const } },
                { identityNote: { contains: options.q, mode: 'insensitive' as const } },
                { closureNote: { contains: options.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  findById(tx: Tx, id: string): Promise<DsarRecord | null> {
    return tx.dsarRequest
      .findFirst({ where: { id, organisationId: this.organisationId }, select: SELECT })
      .then((row) => (row ? toRecord(row) : null));
  }

  /** The identity columns stay NULL: a request that has arrived has not yet been proven anyone's. */
  create(tx: Tx, data: DsarNewRequest, createdByUserId: string): Promise<DsarRecord> {
    return tx.dsarRequest
      .create({
        data: { ...data, organisationId: this.organisationId, createdByUserId },
        select: SELECT,
      })
      .then(toRecord);
  }

  /** Optimistic locking: the change lands only while the row still carries the version that was read. */
  async update(tx: Tx, id: string, version: number, data: DsarChanges): Promise<boolean> {
    const result = await tx.dsarRequest.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** Every request received on or after the given day, in the three columns the SLA reads. */
  slaRows(tx: Tx, receivedFrom: string): Promise<DsarSlaRow[]> {
    return tx.dsarRequest.findMany({
      where: {
        organisationId: this.organisationId,
        receivedOn: { gte: new Date(`${receivedFrom}T00:00:00.000Z`) },
      },
      orderBy: { id: 'asc' },
      select: { status: true, dueOn: true, completedOn: true },
    });
  }

  // ---- the communication log (append-only)

  listCommunications(tx: Tx, requestId: string): Promise<DsarCommunicationRecord[]> {
    return tx.dsarCommunication.findMany({
      where: { organisationId: this.organisationId, dsarRequestId: requestId },
      // the case as it was lived: the day first, then the order the lines were written in
      orderBy: [{ occurredOn: 'asc' }, { id: 'asc' }],
      select: COMMUNICATION_SELECT,
    });
  }

  createCommunication(
    tx: Tx,
    data: {
      dsarRequestId: string;
      kind: DsarCommunicationKind;
      occurredOn: Date;
      note: string;
      createdByUserId: string;
    },
  ): Promise<DsarCommunicationRecord> {
    return tx.dsarCommunication.create({
      data: { ...data, organisationId: this.organisationId },
      select: COMMUNICATION_SELECT,
    });
  }

  // ---- the evidence links

  listEvidence(tx: Tx, requestId: string): Promise<DsarEvidenceRecord[]> {
    return tx.dsarRequestEvidence
      .findMany({
        where: { organisationId: this.organisationId, dsarRequestId: requestId },
        orderBy: { linkedAt: 'asc' },
        select: EVIDENCE_LINK_SELECT,
      })
      .then((rows) => rows.map(toEvidence));
  }

  /** The ids of this organisation's own evidence files among the ones asked for. */
  async findEvidence(tx: Tx, evidenceIds: string[]): Promise<string[]> {
    const rows = await tx.evidence.findMany({
      where: { id: { in: evidenceIds }, organisationId: this.organisationId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  evidenceCount(tx: Tx, requestId: string): Promise<number> {
    return tx.dsarRequestEvidence.count({
      where: { organisationId: this.organisationId, dsarRequestId: requestId },
    });
  }

  /** False when the same file is already attached: the unique key is the tenant, the request and the file. */
  async linkEvidence(
    tx: Tx,
    requestId: string,
    evidenceId: string,
    linkedByUserId: string,
  ): Promise<boolean> {
    const created = await tx.dsarRequestEvidence.createManyAndReturn({
      data: [
        {
          organisationId: this.organisationId,
          dsarRequestId: requestId,
          evidenceId,
          linkedByUserId,
        },
      ],
      select: { id: true },
      skipDuplicates: true,
    });
    return created.length === 1;
  }

  async unlinkEvidence(tx: Tx, requestId: string, evidenceId: string): Promise<boolean> {
    const result = await tx.dsarRequestEvidence.deleteMany({
      where: { organisationId: this.organisationId, dsarRequestId: requestId, evidenceId },
    });
    return result.count === 1;
  }

  // ---- the extension ledger (append-only, and the guard reads it after every write)

  createExtension(
    tx: Tx,
    data: {
      dsarRequestId: string;
      days: number;
      reason: string;
      previousDueOn: Date;
      newDueOn: Date;
      decidedByUserId: string;
    },
  ): Promise<void> {
    return tx.dsarExtension
      .create({ data: { ...data, organisationId: this.organisationId }, select: { id: true } })
      .then(() => undefined);
  }

  /**
   * The record an alert job has to re-read. The delivery row is the alerts module's, so the job's id is
   * followed through this model's own relation instead of reaching into another module's table.
   */
  findByAlertId(tx: Tx, alertId: string): Promise<DsarAlertRecord | null> {
    return tx.dsarRequest.findFirst({
      where: { organisationId: this.organisationId, alertDeliveries: { some: { id: alertId } } },
      select: { id: true, status: true, dueOn: true },
    });
  }

  // ---- the checks that make a reference valid in THIS organisation

  findActiveMember(tx: Tx, membershipId: string): Promise<{ id: string } | null> {
    return tx.membership.findFirst({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true },
    });
  }

  findBusinessUnit(tx: Tx, id: string): Promise<{ id: string } | null> {
    return tx.businessUnit.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true },
    });
  }

  /** The organisation's row, for the time zone a deadline is judged and an alert is timed in. */
  async timezone(tx: Tx): Promise<string> {
    const row = await tx.organisation.findUnique({
      where: { id: this.organisationId },
      select: { timezone: true },
    });
    if (!row) {
      throw new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Organisation not found.');
    }
    return row.timezone;
  }
}
