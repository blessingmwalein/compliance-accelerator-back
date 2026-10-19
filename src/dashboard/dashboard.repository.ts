import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import {
  OUTSTANDING_TASK_STATUSES,
  type CycleRow,
  type ItemRow,
} from '../domain/dashboard/metrics.js';
import { toDateOnly } from '../domain/registers/review.js';
import type { RiskLevel } from '../domain/scoring/methodologies.js';
import { RequestContext } from '../tenancy/request-context.js';

/** A company detail the getting-started step needs, straight off the tenant root row. */
export interface OrganisationFacts {
  name: string;
  timezone: string;
  country: string | null;
  dpoEmail: string | null;
}

/** An assessed subject plus the names it is shown under, read in the same query rather than per row. */
export interface DashboardItemRow extends ItemRow {
  governanceAreaName: string | null;
  businessUnitName: string | null;
  frameworkCode: string | null;
  requirementRef: string | null;
}

/** A framework the organisation declared applicable. */
export interface ApplicableFramework {
  id: string;
  code: string;
  name: string;
  jurisdiction: string;
  kind: string;
}

/** A usable (verified or published) version of a framework, newest first, with how many requirements it holds. */
export interface FrameworkVersionRow {
  id: string;
  frameworkId: string;
  label: string;
  status: string;
  requirementCount: number;
}

/** A risk as the top-exposure list shows it: its own stored derivation and the names around it. */
export interface TopRiskRow {
  id: string;
  title: string;
  status: string;
  category: string | null;
  governanceAreaName: string | null;
  businessUnitName: string | null;
  frameworkCode: string | null;
  assessmentItemId: string | null;
  ownerName: string | null;
  treatmentPlan: string | null;
  /** The register's next-action date, as the organisation's calendar day. */
  reviewByDate: string | null;
  inherentScore: number | null;
  inherentLevel: RiskLevel | null;
  inherentLikelihood: number | null;
  inherentSeverity: number | null;
  residualScore: number | null;
  residualLevel: RiskLevel | null;
  residualLikelihood: number | null;
  residualSeverity: number | null;
}

/** One outstanding remediation task, as the top-risk list names it. */
export interface RelatedTaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  assessmentItemId: string | null;
}

/** The existence counts the getting-started steps are derived from. */
export interface OnboardingCounts {
  businessUnits: number;
  ropaActivities: number;
  classifiedActivities: number;
  approvedMappings: number;
}

const ITEM_SELECT = {
  id: true,
  assessmentId: true,
  governanceAreaId: true,
  requirementId: true,
  businessUnitId: true,
  frameworkId: true,
  currentMaturity: true,
  targetMaturity: true,
  gap: true,
  exposure: true,
  riskLevel: true,
  governanceArea: { select: { name: true } },
  businessUnit: { select: { name: true } },
  framework: { select: { code: true } },
  requirement: { select: { ref: true } },
} as const;

const RISK_SELECT = {
  id: true,
  title: true,
  status: true,
  category: true,
  assessmentItemId: true,
  treatmentPlan: true,
  reviewByDate: true,
  inherentScore: true,
  inherentLevel: true,
  inherentLikelihood: true,
  inherentSeverity: true,
  residualScore: true,
  residualLevel: true,
  residualLikelihood: true,
  residualSeverity: true,
  governanceArea: { select: { name: true } },
  businessUnit: { select: { name: true } },
  framework: { select: { code: true } },
  owner: { select: { user: { select: { fullName: true } } } },
} as const;

type ItemRowShape = {
  id: string;
  assessmentId: string;
  governanceAreaId: string | null;
  requirementId: string | null;
  businessUnitId: string | null;
  frameworkId: string | null;
  currentMaturity: number | null;
  targetMaturity: number | null;
  gap: number | null;
  exposure: number | null;
  riskLevel: RiskLevel | null;
  governanceArea: { name: string } | null;
  businessUnit: { name: string } | null;
  framework: { code: string } | null;
  requirement: { ref: string } | null;
};

type RiskRowShape = {
  id: string;
  title: string;
  status: string;
  category: string | null;
  assessmentItemId: string | null;
  treatmentPlan: string | null;
  reviewByDate: Date | null;
  inherentScore: number | null;
  inherentLevel: RiskLevel | null;
  inherentLikelihood: number | null;
  inherentSeverity: number | null;
  residualScore: number | null;
  residualLevel: RiskLevel | null;
  residualLikelihood: number | null;
  residualSeverity: number | null;
  governanceArea: { name: string } | null;
  businessUnit: { name: string } | null;
  framework: { code: string } | null;
  owner: { user: { fullName: string } } | null;
};

const toItemRow = (row: ItemRowShape): DashboardItemRow => ({
  id: row.id,
  assessmentId: row.assessmentId,
  governanceAreaId: row.governanceAreaId,
  governanceAreaName: row.governanceArea?.name ?? null,
  requirementId: row.requirementId,
  requirementRef: row.requirement?.ref ?? null,
  businessUnitId: row.businessUnitId,
  businessUnitName: row.businessUnit?.name ?? null,
  frameworkId: row.frameworkId,
  frameworkCode: row.framework?.code ?? null,
  currentMaturity: row.currentMaturity,
  targetMaturity: row.targetMaturity,
  gap: row.gap,
  exposure: row.exposure,
  riskLevel: row.riskLevel,
});

const toRiskRow = (row: RiskRowShape): TopRiskRow => ({
  id: row.id,
  title: row.title,
  status: row.status,
  category: row.category ?? null,
  governanceAreaName: row.governanceArea?.name ?? null,
  businessUnitName: row.businessUnit?.name ?? null,
  frameworkCode: row.framework?.code ?? null,
  assessmentItemId: row.assessmentItemId,
  ownerName: row.owner?.user.fullName ?? null,
  treatmentPlan: row.treatmentPlan,
  reviewByDate: toDateOnly(row.reviewByDate),
  inherentScore: row.inherentScore,
  inherentLevel: row.inherentLevel,
  inherentLikelihood: row.inherentLikelihood,
  inherentSeverity: row.inherentSeverity,
  residualScore: row.residualScore,
  residualLevel: row.residualLevel,
  residualLikelihood: row.residualLikelihood,
  residualSeverity: row.residualSeverity,
});

/**
 * The dashboard's reads (Phase 8): a handful of set-based queries, never one per card and never one per row.
 *
 * Only the metrics no other module answers for are read here. A register, RoPA, DSAR, breach or priority
 * count keeps its own endpoint (`docs/metrics/README.md`: the dashboard's cards "are the counts above, not
 * recomputed ones"), because a second copy of `overdue` is a second definition waiting to disagree.
 */
@Injectable()
export class DashboardRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Every cycle, whatever its state: the domain decides which ones count. */
  cycles(tx: Tx): Promise<CycleRow[]> {
    return tx.assessment.findMany({
      where: { organisationId: this.organisationId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        status: true,
        methodologyId: true,
        methodologyVersion: true,
        submittedAt: true,
        approvedAt: true,
        createdAt: true,
      },
    });
  }

  /** Every assessed subject, with the names it is shown under and the derivations its cycle froze. */
  async items(tx: Tx): Promise<DashboardItemRow[]> {
    const rows = await tx.assessmentItem.findMany({
      where: { organisationId: this.organisationId },
      orderBy: { id: 'asc' },
      select: ITEM_SELECT,
    });
    return rows.map(toItemRow);
  }

  /** The tenant root row: the timezone every date is decided in, and the company details step. */
  organisationFacts(tx: Tx): Promise<OrganisationFacts | null> {
    return tx.organisation.findUnique({
      where: { id: this.organisationId },
      select: { name: true, timezone: true, country: true, dpoEmail: true },
    });
  }

  /** The frameworks the organisation currently holds as applicable, in the catalogue's own order. */
  async applicableFrameworks(tx: Tx): Promise<ApplicableFramework[]> {
    const rows = await tx.organisationFramework.findMany({
      where: { organisationId: this.organisationId, removedAt: null },
      orderBy: { framework: { sortOrder: 'asc' } },
      select: {
        framework: { select: { id: true, code: true, name: true, jurisdiction: true, kind: true } },
      },
    });
    return rows.map(({ framework }) => framework);
  }

  /**
   * The usable versions of these frameworks (global reference data, never tenant-scoped), newest version
   * first, so the caller takes the head per framework as the one the organisation is measured against.
   */
  async frameworkVersions(tx: Tx, frameworkIds: readonly string[]): Promise<FrameworkVersionRow[]> {
    if (frameworkIds.length === 0) return [];
    const rows = await tx.frameworkVersion.findMany({
      where: { frameworkId: { in: [...frameworkIds] }, status: { in: ['VERIFIED', 'PUBLISHED'] } },
      orderBy: [{ effectiveFrom: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: {
        id: true,
        frameworkId: true,
        label: true,
        status: true,
        _count: { select: { requirements: true } },
      },
    });
    return rows.map(({ _count, ...row }) => ({ ...row, requirementCount: _count.requirements }));
  }

  /** The four existence counts the getting-started steps ask about, in one round trip. */
  async onboardingCounts(tx: Tx): Promise<OnboardingCounts> {
    const organisationId = this.organisationId;
    const [businessUnits, ropaActivities, classifiedActivities, approvedMappings] =
      await Promise.all([
        tx.businessUnit.count({ where: { organisationId, archivedAt: null } }),
        tx.ropaActivity.count({ where: { organisationId, status: { not: 'ARCHIVED' } } }),
        tx.ropaActivity.count({
          where: {
            organisationId,
            status: { not: 'ARCHIVED' },
            classificationLevelId: { not: null },
          },
        }),
        tx.organisationMapping.count({
          where: { organisationId, archivedAt: null, reviewStatus: 'APPROVED' },
        }),
      ]);
    return { businessUnits, ropaActivities, classifiedActivities, approvedMappings };
  }

  /** Outstanding findings per framework: the number a compliance card shows beside its coverage. */
  async openTasksByFramework(tx: Tx): Promise<Map<string, number>> {
    const rows = await tx.remediationTask.groupBy({
      by: ['frameworkId'],
      where: {
        organisationId: this.organisationId,
        status: { in: [...OUTSTANDING_TASK_STATUSES] },
      },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.frameworkId !== null) counts.set(row.frameworkId, row._count._all);
    }
    return counts;
  }

  /** The carried risks: a CLOSED risk is history, so it never appears on a dashboard ranking. */
  async openRisks(tx: Tx): Promise<TopRiskRow[]> {
    const rows = await tx.risk.findMany({
      where: { organisationId: this.organisationId, status: { not: 'CLOSED' } },
      orderBy: { id: 'asc' },
      select: RISK_SELECT,
    });
    return rows.map(toRiskRow);
  }

  /**
   * The outstanding tasks of these assessment items in one read. The oldest task (ids are UUIDv7) is the
   * one a row names, so the same risk points at the same task on every reload.
   */
  async openTasksForItems(tx: Tx, itemIds: readonly string[]): Promise<RelatedTaskRow[]> {
    if (itemIds.length === 0) return [];
    const rows = await tx.remediationTask.findMany({
      where: {
        organisationId: this.organisationId,
        status: { in: [...OUTSTANDING_TASK_STATUSES] },
        assessmentItemId: { in: [...itemIds] },
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        assessmentItemId: true,
      },
    });
    return rows.map((row) => ({ ...row, dueDate: toDateOnly(row.dueDate) }));
  }
}
