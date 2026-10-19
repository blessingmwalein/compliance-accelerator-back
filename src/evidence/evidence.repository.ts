import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { EvidenceReviewStatus, EvidenceScanState } from '../domain/incidents/evidence.js';
import { RequestContext } from '../tenancy/request-context.js';

/**
 * One stored file of an evidence record. `storageKey` is the opaque place of the bytes: it is for the
 * service's storage call only and is never put in a DTO, a log line or an audit event.
 */
export interface EvidenceVersionRecord {
  id: string;
  number: number;
  originalFilename: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
  note: string | null;
  uploadedByUserId: string;
  createdAt: Date;
}

/**
 * An evidence row (Phase 7): what a person browses, owns and reviews. The file columns live in
 * `evidence_versions`; `current` is the version `currentVersion` points at (the newest stored one),
 * joined so a single read answers the list and detail views without a second query.
 */
export interface EvidenceRecord {
  id: string;
  title: string;
  description: string | null;
  currentVersion: number;
  ownerMembershipId: string | null;
  reviewStatus: EvidenceReviewStatus;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
  scanState: EvidenceScanState;
  scannedOn: Date | null;
  scanNote: string | null;
  attestedByUserId: string | null;
  uploadedByUserId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  current: EvidenceVersionRecord | null;
}

/** A row plus the ids of the records it is attached to (read-only; the links belong to other modules). */
export interface EvidenceDetailRecord extends EvidenceRecord {
  linkedItemIds: string[];
  linkedTaskIds: string[];
}

/** The evidence row plus the version-1 file, all decided by the service from the bytes it received. */
export interface EvidenceCreateFields {
  id: string;
  title: string;
  description: string | null;
  uploadedByUserId: string;
  originalFilename: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
}

/** The metadata a PATCH may change. The bytes (name, type, size, checksum, key) belong to a version. */
export type EvidenceMetadataChanges = Partial<{
  title: string;
  description: string | null;
  ownerMembershipId: string | null;
}>;

/** One new version row, numbered by the service from the current maximum. */
export interface EvidenceVersionCreateFields {
  evidenceId: string;
  number: number;
  originalFilename: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
  note: string | null;
  uploadedByUserId: string;
}

export type EvidenceReviewChanges = {
  reviewStatus: EvidenceReviewStatus;
  reviewedByUserId: string | null;
  reviewNote: string | null;
};

export type EvidenceScanChanges = {
  scanState: EvidenceScanState;
  scannedOn: Date | null;
  scanNote: string | null;
  attestedByUserId: string | null;
};

const VERSION_SELECT = {
  id: true,
  number: true,
  originalFilename: true,
  contentType: true,
  size: true,
  sha256: true,
  storageKey: true,
  note: true,
  uploadedByUserId: true,
  createdAt: true,
} as const;

const EVIDENCE_SELECT = {
  id: true,
  title: true,
  description: true,
  currentVersion: true,
  ownerMembershipId: true,
  reviewStatus: true,
  reviewedByUserId: true,
  reviewNote: true,
  lastReviewDate: true,
  nextReviewDate: true,
  scanState: true,
  scannedOn: true,
  scanNote: true,
  attestedByUserId: true,
  uploadedByUserId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  // `current_version` is always the newest stored version (the version guard keeps the pointer and the
  // ledger in step), so the highest-numbered row IS the current one — no correlated subquery needed.
  versions: { orderBy: { number: 'desc' as const }, take: 1, select: VERSION_SELECT },
} as const;

type EvidenceRow = Omit<EvidenceRecord, 'current'> & { versions: EvidenceVersionRecord[] };

const toRecord = (row: EvidenceRow): EvidenceRecord => {
  const { versions, ...base } = row;
  return { ...base, current: versions[0] ?? null };
};

/**
 * Evidence of the CURRENT organisation (the tenant comes from the request scope, never a parameter).
 * The bytes are not here: they live in storage under the current version's `storageKey`.
 */
@Injectable()
export class EvidenceRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Oldest first (ids are UUIDv7); fetches one extra row to detect another page. */
  list(
    tx: Tx,
    options: {
      limit: number;
      after?: string;
      q?: string;
      reviewStatus?: EvidenceReviewStatus;
      scanState?: EvidenceScanState;
      ownerMembershipId?: string;
    },
  ): Promise<EvidenceRecord[]> {
    return tx.evidence
      .findMany({
        where: {
          organisationId: this.organisationId,
          ...(options.after ? { id: { gt: options.after } } : {}),
          ...(options.q ? { title: { contains: options.q, mode: 'insensitive' as const } } : {}),
          ...(options.reviewStatus ? { reviewStatus: options.reviewStatus } : {}),
          ...(options.scanState ? { scanState: options.scanState } : {}),
          ...(options.ownerMembershipId ? { ownerMembershipId: options.ownerMembershipId } : {}),
        },
        orderBy: { id: 'asc' },
        take: options.limit + 1,
        select: EVIDENCE_SELECT,
      })
      .then((rows) => rows.map(toRecord));
  }

  findById(tx: Tx, id: string): Promise<EvidenceRecord | null> {
    return tx.evidence
      .findFirst({
        where: { id, organisationId: this.organisationId },
        select: EVIDENCE_SELECT,
      })
      .then((row) => (row ? toRecord(row) : null));
  }

  /**
   * The row, its current version and what it is attached to, in one query. Both link tables point at
   * their evidence row with a composite `(organisation_id, evidence_id)` foreign key, so a link can
   * never name another tenant's item.
   */
  async findDetail(tx: Tx, id: string): Promise<EvidenceDetailRecord | null> {
    const row = await tx.evidence.findFirst({
      where: { id, organisationId: this.organisationId },
      select: {
        ...EVIDENCE_SELECT,
        itemLinks: { select: { assessmentItemId: true } },
        taskLinks: { select: { taskId: true } },
      },
    });
    if (!row) return null;
    const { itemLinks, taskLinks, versions, ...base } = row;
    return {
      ...base,
      current: versions[0] ?? null,
      linkedItemIds: itemLinks.map((link) => link.assessmentItemId),
      linkedTaskIds: taskLinks.map((link) => link.taskId),
    };
  }

  /**
   * Creates the record and its version 1 together, so the pointer and the ledger agree from the first
   * row. The id is generated by the service (it is also part of the storage key) so the bytes can
   * precede the row.
   */
  async create(tx: Tx, data: EvidenceCreateFields): Promise<EvidenceRecord> {
    const { originalFilename, contentType, size, sha256, storageKey, ...evidence } = data;
    await tx.evidence.create({
      data: { ...evidence, organisationId: this.organisationId },
    });
    await tx.evidenceVersion.create({
      data: {
        organisationId: this.organisationId,
        evidenceId: data.id,
        number: 1,
        originalFilename,
        contentType,
        size,
        sha256,
        storageKey,
        note: null,
        uploadedByUserId: data.uploadedByUserId,
      },
    });
    const record = await this.findById(tx, data.id);
    if (!record) throw new Error(`Evidence ${data.id} was written but cannot be read back`);
    return record;
  }

  /** Optimistic concurrency: one row, only when it still has the version the caller read. */
  async update(
    tx: Tx,
    id: string,
    version: number,
    data: EvidenceMetadataChanges,
  ): Promise<boolean> {
    const result = await tx.evidence.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  async changeReview(
    tx: Tx,
    id: string,
    version: number,
    data: EvidenceReviewChanges,
  ): Promise<boolean> {
    const result = await tx.evidence.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  async attestScan(
    tx: Tx,
    id: string,
    version: number,
    data: EvidenceScanChanges,
  ): Promise<boolean> {
    const result = await tx.evidence.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  // ---- the version ledger (append-only: the trigger forbids update/delete)

  createVersion(tx: Tx, data: EvidenceVersionCreateFields): Promise<EvidenceVersionRecord> {
    return tx.evidenceVersion.create({
      data: { ...data, organisationId: this.organisationId },
      select: VERSION_SELECT,
    });
  }

  /**
   * Moves `currentVersion` to a newly stored version and resets the attestations that only ever cover
   * the bytes they named: the scan goes back to NOT_SCANNED (the version guard demands it) and the
   * review loses the judgement made about the superseded file. Guarded by `version` (no concurrent
   * supersede may slip past), so a losing caller is told to reload.
   */
  async supersede(tx: Tx, id: string, version: number, currentVersion: number): Promise<boolean> {
    const result = await tx.evidence.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: {
        currentVersion,
        scanState: 'NOT_SCANNED',
        scannedOn: null,
        scanNote: null,
        attestedByUserId: null,
        reviewStatus: 'UNREVIEWED',
        reviewedByUserId: null,
        reviewNote: null,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  listVersions(tx: Tx, evidenceId: string): Promise<EvidenceVersionRecord[]> {
    return tx.evidenceVersion.findMany({
      where: { organisationId: this.organisationId, evidenceId },
      orderBy: { number: 'asc' },
      select: VERSION_SELECT,
    });
  }

  findVersion(tx: Tx, evidenceId: string, number: number): Promise<EvidenceVersionRecord | null> {
    return tx.evidenceVersion.findFirst({
      where: { organisationId: this.organisationId, evidenceId, number },
      select: VERSION_SELECT,
    });
  }

  // ---- the checks that make a reference valid in THIS organisation

  findActiveMember(tx: Tx, membershipId: string): Promise<{ id: string } | null> {
    return tx.membership.findFirst({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true },
    });
  }

  /** The tenant's IANA zone: an attestation is dated on the day the attester lived it, not in UTC. */
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
