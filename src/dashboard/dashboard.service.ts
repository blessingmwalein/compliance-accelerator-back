import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import {
  ELIGIBLE_CYCLE_STATUSES,
  GAP_HIGHLIGHT_LEVELS,
  ONBOARDING_STEPS,
  eligibleItems,
  exposureRoll,
  gapBandsOf,
  maturityRoll,
  onboardingOf,
  topRisks,
  type EligibleItem,
  type OnboardingFacts,
} from '../domain/dashboard/metrics.js';
import { todayIn } from '../domain/remediation/policy.js';
import { summarise } from '../domain/scoring/scoring.js';
import { SCORING_DISCLAIMER, ScoringService } from '../scoring/scoring.service.js';
import type {
  DashboardFrameworksDto,
  DashboardGapAnalysisDto,
  DashboardSummaryDto,
  DashboardTopRisksDto,
  FrameworkAreaMaturityDto,
  GapAnalysisRowDto,
  TopRisksQueryDto,
} from './dashboard.dto.js';
import {
  DashboardRepository,
  type DashboardItemRow,
  type FrameworkVersionRow,
  type RelatedTaskRow,
  type TopRiskRow,
} from './dashboard.repository.js';

/** How many rows `GET …/dashboard/top-risks` returns when the caller does not say. */
const TOP_RISK_DEFAULT_LIMIT = 10;

/** A subject that is not filed under an area still has to be named in the gap list. */
const UNFILED_AREA_NAME = 'Not filed under a governance area';

const NO_FRAMEWORKS_MESSAGE =
  'No framework is applicable yet. Choose them in Company Settings to see coverage and comparison.';

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Organisation not found.');

/** One read's worth of the organisation: its day, its zone and the subjects that count. */
interface DashboardContext {
  /** Today in the organisation's zone: the day every count here is decided against. */
  today: string;
  timezone: string;
  /** One item per subject, taken from the newest submitted or approved cycle that covers it. */
  eligible: (DashboardItemRow & EligibleItem)[];
  /** Whether any cycle has been submitted or approved at all. */
  hasSignedCycle: boolean;
  /** The country and the data protection contact email are both filled in. */
  companyDetails: boolean;
}

/** The figures of one risk on the basis the caller asked for. */
interface BasisFigures {
  score: number | null;
  level: TopRiskRow['residualLevel'];
  likelihood: number | null;
  severity: number | null;
}

/**
 * The executive dashboard (Phase 8): the organisation-wide metrics no other endpoint answers for, each one
 * stated as an availability first and a value only when there is a value to give.
 *
 * The dashboard deliberately does not restate what the registers already answer. The risk summary and heat
 * map, the RoPA monitor, the priority matrix, the DSAR SLA and the breach summary keep their own endpoints
 * and the dashboard reads those, so `overdue` means exactly one thing here
 * (`docs/metrics/README.md`: the cards "are the counts above, not recomputed ones").
 *
 * Every call is ONE unit of work built on set-based reads — no query per card and none per row.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly dashboard: DashboardRepository,
    private readonly scoring: ScoringService,
    private readonly clock: Clock,
  ) {}

  /** `maturity.overall`, `risk.exposure.overall` and `onboarding.progress`. */
  async summary(): Promise<DashboardSummaryDto> {
    return this.uow.run(async (tx) => {
      const context = await this.context(tx);
      const [bands, counts, applicable] = await Promise.all([
        this.scoring.bandsInForce(tx),
        this.dashboard.onboardingCounts(tx),
        this.dashboard.applicableFrameworks(tx),
      ]);

      const maturity = maturityRoll(context.eligible);
      const exposure = exposureRoll(context.eligible, bands);
      const gettingStarted = onboardingOf({
        companyDetails: context.companyDetails,
        businessUnits: counts.businessUnits > 0,
        submittedAssessment: context.hasSignedCycle,
        ropaRecords: counts.ropaActivities > 0,
        classifiedData: counts.classifiedActivities > 0,
        mappingReviewed: applicable.length > 0 && counts.approvedMappings > 0,
      } satisfies OnboardingFacts);

      return {
        asOf: context.today,
        timezone: context.timezone,
        gapHighlightLevels: GAP_HIGHLIGHT_LEVELS,
        maturity: {
          availability: maturity.availability,
          current: maturity.current,
          target: maturity.target,
          gap: maturity.gap,
          applicable: maturity.applicable,
          status: maturity.status,
        },
        exposure: {
          availability: exposure.availability,
          methodologies: exposure.methodologies,
          mean: exposure.mean,
          band: exposure.band,
          byRiskLevel: exposure.byRiskLevel,
          status: exposure.status,
        },
        gettingStarted: {
          completed: gettingStarted.completed,
          total: Object.keys(ONBOARDING_STEPS).length,
          steps: gettingStarted.steps,
        },
        disclaimer: SCORING_DISCLAIMER,
      };
    });
  }

  /**
   * `frameworks.coverage` and `maturity.byFramework` per applicable framework: one payload for the
   * comparison bar, the radar, the table and the compliance cards, so those views cannot disagree.
   */
  async frameworks(): Promise<DashboardFrameworksDto> {
    return this.uow.run(async (tx) => {
      const context = await this.context(tx);
      const applicable = await this.dashboard.applicableFrameworks(tx);
      if (applicable.length === 0) {
        return {
          availability: 'not_configured' as const,
          asOf: context.today,
          gapHighlightLevels: GAP_HIGHLIGHT_LEVELS,
          frameworks: [],
          message: NO_FRAMEWORKS_MESSAGE,
          disclaimer: SCORING_DISCLAIMER,
        };
      }

      const [versions, openTasks] = await Promise.all([
        this.dashboard.frameworkVersions(
          tx,
          applicable.map((frame) => frame.id),
        ),
        this.dashboard.openTasksByFramework(tx),
      ]);
      // versions come newest first, so the first row of a framework is the one it is measured against.
      const newestVersion = new Map<string, FrameworkVersionRow>();
      for (const version of versions) {
        if (!newestVersion.has(version.frameworkId)) {
          newestVersion.set(version.frameworkId, version);
        }
      }

      return {
        availability: 'ok' as const,
        asOf: context.today,
        gapHighlightLevels: GAP_HIGHLIGHT_LEVELS,
        frameworks: applicable.map((frame) => {
          const own = context.eligible.filter((item) => item.frameworkId === frame.id);
          const roll = maturityRoll(own);
          const version = newestVersion.get(frame.id) ?? null;
          return {
            frameworkId: frame.id,
            code: frame.code,
            name: frame.name,
            jurisdiction: frame.jurisdiction,
            kind: frame.kind,
            version: version
              ? { id: version.id, label: version.label, status: version.status }
              : null,
            catalogueControls: version?.requirementCount ?? null,
            inScope: own.length,
            rated: roll.current.assessed,
            current: roll.current,
            target: roll.target,
            gap: roll.gap,
            gapBands: gapBandsOf(own),
            outstandingFindings: openTasks.get(frame.id) ?? 0,
            availability: roll.availability,
            status: roll.status,
            byArea: areaRowsOf(own),
          };
        }),
        message: null,
        disclaimer: SCORING_DISCLAIMER,
      };
    });
  }

  /** `gap.analysis`: each governance area's distance from its target, biggest gap first. */
  async gapAnalysis(): Promise<DashboardGapAnalysisDto> {
    return this.uow.run(async (tx) => {
      const context = await this.context(tx);
      const groups = groupsByArea(context.eligible);

      const rows = [...groups.entries()].map(([areaId, group]): GapAnalysisRowDto => {
        const roll = maturityRoll(group.items);
        return {
          areaId,
          areaName: areaId === null ? UNFILED_AREA_NAME : (group.name ?? UNFILED_AREA_NAME),
          items: group.items.length,
          current: roll.current,
          target: roll.target,
          gap: roll.gap,
          exposure: summarise(group.items).averageExposure,
          highlight: roll.gap.value !== null && roll.gap.value >= GAP_HIGHLIGHT_LEVELS,
          status: roll.status,
        };
      });
      rows.sort(compareGapRows);

      return {
        availability: rows.some((row) => row.gap.value !== null)
          ? ('ok' as const)
          : ('not_assessed' as const),
        asOf: context.today,
        highlightAt: GAP_HIGHLIGHT_LEVELS,
        rows,
        disclaimer: SCORING_DISCLAIMER,
      };
    });
  }

  /** `risk.top`: the carried risks with the most exposure, each with what it is filed under and who owns it. */
  async topRisks(query: TopRisksQueryDto): Promise<DashboardTopRisksDto> {
    return this.uow.run(async (tx) => {
      const context = await this.context(tx);
      const basis = query.basis ?? 'residual';
      const limit = query.limit ?? TOP_RISK_DEFAULT_LIMIT;

      const carried = await this.dashboard.openRisks(tx);
      const ranked = topRisks(carried, basis, limit);
      const tasks = await this.dashboard.openTasksForItems(
        tx,
        ranked.flatMap((risk) => (risk.assessmentItemId === null ? [] : [risk.assessmentItemId])),
      );
      // tasks arrive in id order, so the first one for an item is the oldest task outstanding against it.
      const taskOf = new Map<string, RelatedTaskRow>();
      for (const task of tasks) {
        if (task.assessmentItemId !== null && !taskOf.has(task.assessmentItemId)) {
          taskOf.set(task.assessmentItemId, task);
        }
      }

      return {
        basis,
        availability: carried.length === 0 ? ('no_records' as const) : ('ok' as const),
        asOf: context.today,
        limit,
        items: ranked.map((risk) => {
          const figures = figuresOf(risk, basis);
          const task = risk.assessmentItemId === null ? null : taskOf.get(risk.assessmentItemId);
          return {
            id: risk.id,
            title: risk.title,
            status: risk.status,
            category: risk.category,
            score: figures.score,
            level: figures.level,
            likelihood: figures.likelihood,
            severity: figures.severity,
            governanceAreaName: risk.governanceAreaName,
            businessUnitName: risk.businessUnitName,
            frameworkCode: risk.frameworkCode,
            ownerName: risk.ownerName,
            reviewByDate: risk.reviewByDate,
            nextAction: risk.treatmentPlan,
            task: task
              ? {
                  id: task.id,
                  title: task.title,
                  status: task.status,
                  priority: task.priority,
                  dueDate: task.dueDate,
                }
              : null,
          };
        }),
        unscored: carried.filter((risk) => {
          const figures = figuresOf(risk, basis);
          return figures.score === null || figures.likelihood === null || figures.severity === null;
        }).length,
        disclaimer: SCORING_DISCLAIMER,
      };
    });
  }

  /** The organisation's day, its cycle states and the subjects that count, read once per request. */
  private async context(tx: Tx): Promise<DashboardContext> {
    const [cycles, items, organisation] = await Promise.all([
      this.dashboard.cycles(tx),
      this.dashboard.items(tx),
      this.dashboard.organisationFacts(tx),
    ]);
    if (!organisation) throw notFound();
    return {
      today: todayIn(organisation.timezone, this.clock.now()),
      timezone: organisation.timezone,
      eligible: eligibleItems(items, cycles),
      hasSignedCycle: cycles.some((cycle) => ELIGIBLE_CYCLE_STATUSES.has(cycle.status)),
      companyDetails: organisation.country !== null && organisation.dpoEmail !== null,
    };
  }
}

/** The subjects of one read, grouped under the governance area they are filed in. */
const groupsByArea = (
  items: (DashboardItemRow & EligibleItem)[],
): Map<string | null, { name: string | null; items: (DashboardItemRow & EligibleItem)[] }> => {
  const groups = new Map<
    string | null,
    { name: string | null; items: (DashboardItemRow & EligibleItem)[] }
  >();
  for (const item of items) {
    const held = groups.get(item.governanceAreaId);
    if (held) {
      held.items.push(item);
      if (held.name === null) held.name = item.governanceAreaName;
      continue;
    }
    groups.set(item.governanceAreaId, { name: item.governanceAreaName, items: [item] });
  }
  return groups;
};

/**
 * One framework's own subjects, rolled per governance area with the same `maturityRoll` that rolls the
 * framework total. A radar and a table drawn over these cannot disagree with the bar beside them.
 */
const areaRowsOf = (items: (DashboardItemRow & EligibleItem)[]): FrameworkAreaMaturityDto[] => {
  const rows = [...groupsByArea(items).entries()].map(([areaId, group]) => {
    const roll = maturityRoll(group.items);
    return {
      areaId,
      areaName: areaId === null ? UNFILED_AREA_NAME : (group.name ?? UNFILED_AREA_NAME),
      inScope: roll.applicable,
      rated: roll.current.assessed,
      current: roll.current,
      target: roll.target,
      gap: roll.gap,
      availability: roll.availability,
    };
  });
  rows.sort(compareAreaRows);
  return rows;
};

/** The pair of factors and the stored score and level of the basis the caller chose. */
const figuresOf = (risk: TopRiskRow, basis: 'residual' | 'inherent'): BasisFigures =>
  basis === 'inherent'
    ? {
        score: risk.inherentScore,
        level: risk.inherentLevel,
        likelihood: risk.inherentLikelihood,
        severity: risk.inherentSeverity,
      }
    : {
        score: risk.residualScore,
        level: risk.residualLevel,
        likelihood: risk.residualLikelihood,
        severity: risk.residualSeverity,
      };

/** Biggest mean gap first, then the most exposure, then the name: an unmeasurable row never leads. */
function compareGapRows(a: GapAnalysisRowDto, b: GapAnalysisRowDto): number {
  if (a.gap.value !== b.gap.value) {
    if (a.gap.value === null) return 1;
    if (b.gap.value === null) return -1;
    return b.gap.value - a.gap.value;
  }
  if (a.exposure.value !== b.exposure.value) {
    if (a.exposure.value === null) return 1;
    if (b.exposure.value === null) return -1;
    return b.exposure.value - a.exposure.value;
  }
  return a.areaName.localeCompare(b.areaName);
}

/** Biggest mean gap first, then the name: the same order the gap analysis rows keep, without exposure. */
function compareAreaRows(a: FrameworkAreaMaturityDto, b: FrameworkAreaMaturityDto): number {
  if (a.gap.value !== b.gap.value) {
    if (a.gap.value === null) return 1;
    if (b.gap.value === null) return -1;
    return b.gap.value - a.gap.value;
  }
  return a.areaName.localeCompare(b.areaName);
}
