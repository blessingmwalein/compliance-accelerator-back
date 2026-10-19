import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type {
  BreachChronologyKind,
  BreachNotificationDecisionKind,
  BreachNotificationState,
  BreachStatus,
} from '../domain/incidents/breach.js';
import type { RiskLevel } from '../domain/scoring/methodologies.js';
import { Prisma } from '../generated/prisma/client.js';
import { RequestContext } from '../tenancy/request-context.js';

/** A breach with the names of what it points at, as the API shows it. */
export interface BreachRecord {
  id: string;
  title: string;
  description: string | null;
  status: BreachStatus;
  /** DATE columns: UTC-midnight Dates whose UTC day is the calendar day. */
  detectedOn: Date;
  affectedData: string | null;
  affectedSubjectCount: number | null;
  severity: RiskLevel | null;
  impact: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  policyId: string | null;
  assessmentDays: number | null;
  notificationDays: number | null;
  assessmentDueOn: Date | null;
  notificationDueOn: Date | null;
  notificationState: BreachNotificationState;
  closedOn: Date | null;
  closedByUserId: string | null;
  closureNote: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** The columns a person owns: the registry's content, and nothing about its deadlines or its duty. */
export interface BreachFields {
  title: string;
  description: string | null;
  affectedData: string | null;
  affectedSubjectCount: number | null;
  severity: RiskLevel | null;
  impact: string | null;
  businessUnitId: string | null;
  ownerMembershipId: string | null;
}

/** A new breach: its content, the detection day, and the schedule the policy in force produced. */
export interface NewBreach extends BreachFields {
  detectedOn: Date;
  policyId: string | null;
  assessmentDays: number | null;
  notificationDays: number | null;
  assessmentDueOn: Date | null;
  notificationDueOn: Date | null;
}

export type BreachChanges = Partial<BreachFields> & {
  status?: BreachStatus;
  notificationState?: BreachNotificationState;
  closedOn?: Date | null;
  closedByUserId?: string | null;
  closureNote?: string | null;
};

/** One event of the append-only timeline. */
export interface ChronologyRecord {
  id: string;
  breachId: string;
  kind: BreachChronologyKind;
  occurredOn: Date;
  note: string;
  createdByUserId: string;
  createdByName: string | null;
  createdAt: Date;
}

/** One row of the append-only notification ledger. */
export interface DecisionRecord {
  id: string;
  breachId: string;
  decision: BreachNotificationDecisionKind;
  regulatorContactId: string | null;
  regulatorAuthorityName: string | null;
  authorityName: string | null;
  targetDate: Date | null;
  reason: string;
  decidedByUserId: string;
  decidedByName: string | null;
  decidedAt: Date;
}

/** An evidence file attached to a breach, read through the link row. */
export interface EvidenceLinkRecord {
  evidenceId: string;
  title: string;
  currentVersion: number;
  linkedAt: Date;
}

/** The columns the summary counts, and the columns a queued alert is judged against at send time. */
export interface BreachAggregateRow {
  id: string;
  status: BreachStatus;
  detectedOn: Date;
  assessmentDueOn: Date | null;
  notificationDueOn: Date | null;
  notificationState: BreachNotificationState;
  severity: RiskLevel | null;
}

const SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  detectedOn: true,
  affectedData: true,
  affectedSubjectCount: true,
  severity: true,
  impact: true,
  businessUnitId: true,
  ownerMembershipId: true,
  policyId: true,
  assessmentDays: true,
  notificationDays: true,
  assessmentDueOn: true,
  notificationDueOn: true,
  notificationState: true,
  closedOn: true,
  closedByUserId: true,
  closureNote: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  businessUnit: { select: { name: true } },
  owner: { select: { user: { select: { fullName: true } } } },
} as const;

const toRecord = (row: Prisma.BreachGetPayload<{ select: typeof SELECT }>): BreachRecord => {
  const { businessUnit, owner, ...rest } = row;
  return {
    ...rest,
    businessUnitName: businessUnit?.name ?? null,
    ownerName: owner?.user.fullName ?? null,
  };
};

const CHRONOLOGY_SELECT = {
  id: true,
  breachId: true,
  kind: true,
  occurredOn: true,
  note: true,
  createdByUserId: true,
  createdAt: true,
  createdBy: { select: { fullName: true } },
} as const;

const toChronology = (
  row: Prisma.BreachChronologyEntryGetPayload<{ select: typeof CHRONOLOGY_SELECT }>,
): ChronologyRecord => {
  const { createdBy, ...rest } = row;
  return { ...rest, createdByName: createdBy.fullName };
};

const DECISION_SELECT = {
  id: true,
  breachId: true,
  decision: true,
  regulatorContactId: true,
  authorityName: true,
  targetDate: true,
  reason: true,
  decidedByUserId: true,
  decidedAt: true,
  decidedBy: { select: { fullName: true } },
  regulator: { select: { authorityName: true } },
} as const;

const toDecision = (
  row: Prisma.BreachNotificationDecisionGetPayload<{ select: typeof DECISION_SELECT }>,
): DecisionRecord => {
  const { decidedBy, regulator, ...rest } = row;
  return {
    ...rest,
    decidedByName: decidedBy.fullName,
    regulatorAuthorityName: regulator?.authorityName ?? null,
  };
};

const LINK_SELECT = {
  evidenceId: true,
  linkedAt: true,
  evidence: { select: { title: true, currentVersion: true } },
} as const;

const AGGREGATE_SELECT = {
  id: true,
  status: true,
  detectedOn: true,
  assessmentDueOn: true,
  notificationDueOn: true,
  notificationState: true,
  severity: true,
} as const;

export interface ListOptions {
  limit: number;
  after?: string;
  q?: string;
  status?: BreachStatus;
  notificationState?: BreachNotificationState;
  businessUnitId?: string;
  ownerMembershipId?: string;
  /** Only breaches whose notification duty falls due on or before this calendar day. */
  dueBefore?: string;
  /** Hide CLOSED breaches: the view that only wants what is still being worked. */
  excludeClosed?: boolean;
}

/**
 * The breach registry of the CURRENT organisation, in creation order (ids are UUIDv7).
 *
 * The chronology and the decision ledger are append-only tables (the migration's triggers refuse UPDATE
 * and DELETE), so nothing here can rewrite them; `breach_evidence` is a link table and the only one this
 * module deletes from. Evidence ids are proven tenant-owned by reading `evidence` through this repository
 * rather than by importing the evidence module.
 */
@Injectable()
export class BreachesRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Newest breach first: the registry is read as the incidents come in, most recent on top. */
  async list(tx: Tx, options: ListOptions): Promise<BreachRecord[]> {
    const rows = await tx.breach.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.status
          ? { status: options.status }
          : options.excludeClosed
            ? { status: { not: 'CLOSED' as const } }
            : {}),
        ...(options.notificationState ? { notificationState: options.notificationState } : {}),
        ...(options.businessUnitId ? { businessUnitId: options.businessUnitId } : {}),
        ...(options.ownerMembershipId ? { ownerMembershipId: options.ownerMembershipId } : {}),
        // the indexed column: the notification duty is the deadline the registry is judged on
        ...(options.dueBefore
          ? { notificationDueOn: { lte: new Date(`${options.dueBefore}T00:00:00.000Z`) } }
          : {}),
        ...(options.after ? { id: { lt: options.after } } : {}),
        ...(options.q
          ? {
              OR: [
                { title: { contains: options.q, mode: 'insensitive' as const } },
                { description: { contains: options.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'desc' },
      take: options.limit + 1,
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  findById(tx: Tx, id: string): Promise<BreachRecord | null> {
    return tx.breach
      .findFirst({ where: { id, organisationId: this.organisationId }, select: SELECT })
      .then((row) => (row ? toRecord(row) : null));
  }

  create(tx: Tx, data: NewBreach, createdByUserId: string): Promise<BreachRecord> {
    return tx.breach
      .create({
        data: { ...data, organisationId: this.organisationId, createdByUserId },
        select: SELECT,
      })
      .then(toRecord);
  }

  /** Optimistic locking: the change lands only while the row still carries the version that was read. */
  async update(tx: Tx, id: string, version: number, data: BreachChanges): Promise<boolean> {
    const result = await tx.breach.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** The counting columns of every breach: the summary is decided over these, in one read. */
  aggregateRows(tx: Tx): Promise<BreachAggregateRow[]> {
    return tx.breach.findMany({
      where: { organisationId: this.organisationId },
      orderBy: { id: 'asc' },
      select: AGGREGATE_SELECT,
    });
  }

  // ---- the timeline (append-only)

  async listChronology(tx: Tx, breachId: string): Promise<ChronologyRecord[]> {
    const rows = await tx.breachChronologyEntry.findMany({
      where: { organisationId: this.organisationId, breachId },
      // the day the step happened, oldest first; same day keeps the order the entries were written
      orderBy: [{ occurredOn: 'asc' }, { id: 'asc' }],
      select: CHRONOLOGY_SELECT,
    });
    return rows.map(toChronology);
  }

  createChronology(
    tx: Tx,
    data: {
      breachId: string;
      kind: BreachChronologyKind;
      occurredOn: Date;
      note: string;
      createdByUserId: string;
    },
  ): Promise<ChronologyRecord> {
    return tx.breachChronologyEntry
      .create({ data: { ...data, organisationId: this.organisationId }, select: CHRONOLOGY_SELECT })
      .then(toChronology);
  }

  // ---- the notification ledger (append-only)

  async listDecisions(tx: Tx, breachId: string): Promise<DecisionRecord[]> {
    const rows = await tx.breachNotificationDecision.findMany({
      where: { organisationId: this.organisationId, breachId },
      // newest decision first, in the order the trigger reads the head of the ledger
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      select: DECISION_SELECT,
    });
    return rows.map(toDecision);
  }

  createDecision(
    tx: Tx,
    data: {
      breachId: string;
      decision: BreachNotificationDecisionKind;
      regulatorContactId: string | null;
      authorityName: string | null;
      targetDate: Date | null;
      reason: string;
      decidedByUserId: string;
    },
  ): Promise<DecisionRecord> {
    return tx.breachNotificationDecision
      .create({ data: { ...data, organisationId: this.organisationId }, select: DECISION_SELECT })
      .then(toDecision);
  }

  /** Any decision on the record at all: the question a closure is refused on. */
  async hasDecisions(tx: Tx, breachId: string): Promise<boolean> {
    const count = await tx.breachNotificationDecision.count({
      where: { organisationId: this.organisationId, breachId },
    });
    return count > 0;
  }

  // ---- evidence links

  /** The evidence rows attached to this breach, oldest link first. */
  async listEvidence(tx: Tx, breachId: string): Promise<EvidenceLinkRecord[]> {
    const rows = await tx.breachEvidence.findMany({
      where: { organisationId: this.organisationId, breachId },
      orderBy: [{ linkedAt: 'asc' }, { id: 'asc' }],
      select: LINK_SELECT,
    });
    return rows.map((row) => ({
      evidenceId: row.evidenceId,
      title: row.evidence.title,
      currentVersion: row.evidence.currentVersion,
      linkedAt: row.linkedAt,
    }));
  }

  /** Proves the ids are this tenant's: the `evidence` table is read here, never through another module. */
  findEvidence(
    tx: Tx,
    evidenceIds: string[],
  ): Promise<{ id: string; title: string; currentVersion: number }[]> {
    return tx.evidence.findMany({
      where: { id: { in: evidenceIds }, organisationId: this.organisationId },
      select: { id: true, title: true, currentVersion: true },
    });
  }

  findLink(tx: Tx, breachId: string, evidenceId: string): Promise<{ id: string } | null> {
    return tx.breachEvidence.findFirst({
      where: { organisationId: this.organisationId, breachId, evidenceId },
      select: { id: true },
    });
  }

  createLink(
    tx: Tx,
    data: { breachId: string; evidenceId: string; linkedByUserId: string },
  ): Promise<void> {
    return tx.breachEvidence
      .create({ data: { ...data, organisationId: this.organisationId }, select: { id: true } })
      .then(() => undefined);
  }

  async deleteLink(tx: Tx, breachId: string, evidenceId: string): Promise<boolean> {
    const result = await tx.breachEvidence.deleteMany({
      where: { organisationId: this.organisationId, breachId, evidenceId },
    });
    return result.count === 1;
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

  findRegulator(tx: Tx, id: string): Promise<{ id: string } | null> {
    return tx.regulatorContact.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true },
    });
  }

  // ---- the alert queue, read at send time

  /**
   * The breach an alert row is about, resolved from the delivery row: the job payload carries the delivery
   * id only, so the record has to be found through the ledger (`alert_deliveries` names exactly one source).
   */
  breachIdOfAlert(tx: Tx, alertId: string): Promise<string | null> {
    return tx.alertDelivery
      .findFirst({
        where: { id: alertId, organisationId: this.organisationId },
        select: { breachId: true },
      })
      .then((row) => row?.breachId ?? null);
  }

  /** What the breach still says, for the single question an alert asks at send time. */
  forAlert(tx: Tx, breachId: string): Promise<BreachAggregateRow | null> {
    return tx.breach.findFirst({
      where: { id: breachId, organisationId: this.organisationId },
      select: AGGREGATE_SELECT,
    });
  }

  /** The organisation's row, for the time zone a deadline and its alert are judged in. */
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
