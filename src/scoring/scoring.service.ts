import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AppException, ErrorCode, type FieldError } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { DEFAULT_DUE_DAYS, type TaskPriority } from '../domain/remediation/policy.js';
import { TASK_PRIORITIES } from '../domain/remediation/policy.js';
import {
  DEFAULT_PLAN_WINDOW,
  IMPORTANCE_QUESTIONS,
  QUADRANT_INFO,
  QUADRANTS,
  URGENCY_QUESTIONS,
} from '../domain/prioritisation/eisenhower.js';
import {
  bandsFrom,
  thresholdsOf,
  validateThresholds,
  type BandThresholds,
} from '../domain/scoring/bands.js';
import type { Band } from '../domain/scoring/methodologies.js';
import {
  EXPOSURE_V1,
  LIKELIHOOD_LABELS,
  MATURITY_LABELS,
  SENSITIVITY_LABELS,
  SEVERITY_LABELS,
  attainableExposureValues,
} from '../domain/scoring/methodologies.js';
import type { PlanWindowDto, ScoringDto, UpdateScoringDto } from './scoring.dto.js';
import {
  ScoringPolicyRepository,
  type PolicyChanges,
  type PolicyRecord,
} from './scoring.repository.js';

/** Every scoring surface carries this wording (grc-domain section 8): a score is not a legal verdict. */
export const SCORING_DISCLAIMER =
  'Assessments, maturity levels, exposure scores and quadrants are informative aids for a compliance ' +
  'programme. They do not constitute legal advice and do not guarantee compliance with any law. ' +
  'The bands and due-day defaults are reference values an organisation may change.';

/** Days until a new remediation task is due, by priority. */
export type DueDays = Readonly<Record<TaskPriority, number>>;

const labelsOf = (labels: Readonly<Record<number, string>>) =>
  Object.entries(labels).map(([value, label]) => ({ value: Number(value), label }));

/** The thresholds a stored policy JSON holds, or null when absent or unusable ("the reference defaults"). */
function readThresholds(raw: unknown): BandThresholds | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const numbers = ['lowMax', 'mediumMax', 'highMax'].map((key) => value[key]);
  if (!numbers.every((n) => typeof n === 'number' && Number.isInteger(n))) return null;
  return {
    lowMax: numbers[0] as number,
    mediumMax: numbers[1] as number,
    highMax: numbers[2] as number,
  };
}

function readDueDays(raw: unknown): DueDays | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const days: Record<string, number> = {};
  for (const priority of TASK_PRIORITIES) {
    const days_ = value[priority];
    if (typeof days_ !== 'number' || !Number.isInteger(days_) || days_ < 1 || days_ > 365)
      return null;
    days[priority] = days_;
  }
  return days as DueDays;
}

function readPlanWindow(raw: unknown): PlanWindowDto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { minDays, maxDays } = value as { minDays: unknown; maxDays: unknown };
  if (
    typeof minDays !== 'number' ||
    typeof maxDays !== 'number' ||
    !Number.isInteger(minDays) ||
    !Number.isInteger(maxDays) ||
    minDays < 1 ||
    maxDays > 365 ||
    minDays > maxDays
  ) {
    return null;
  }
  return { minDays, maxDays };
}

/** A policy as the service sees it: nulls mean "the reference default" for that part. */
export interface EffectivePolicy {
  bands: readonly Band[];
  thresholds: BandThresholds;
  customisedBands: boolean;
  dueDays: DueDays;
  customisedDueDays: boolean;
  planWindow: PlanWindowDto;
  customisedPlanWindow: boolean;
  version: number;
}

const invalid = (errors: FieldError[]) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    errors,
  );

const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'The scoring policy was changed by someone else. Reload and try again.',
  );

/**
 * The organisation's scoring and scheduling policy. Nothing here is a legal rule: the bands, the due days and
 * the Plan window are reference defaults the organisation may override, and a column that is NULL means it
 * has not. `exposure_v1` keeps its four band names and its full range; only the three thresholds change.
 */
@Injectable()
export class ScoringService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policies: ScoringPolicyRepository,
    private readonly audit: AuditService,
  ) {}

  get(): Promise<ScoringDto> {
    return this.uow.run((tx) => this.policies.get(tx)).then((record) => this.toDto(record));
  }

  /** The bands in force, for a service that must snapshot them (an assessment freezes them at creation). */
  async bandsInForce(tx: Tx): Promise<readonly Band[]> {
    return this.effective(await this.policies.get(tx)).bands;
  }

  /**
   * The whole policy as it applies, inside a caller's transaction. Another module reads its due days or its
   * Plan window through this, so a deadline can never be decided by rules that differ from the ones
   * `GET …/scoring` reports (CLAUDE.md: cross-module calls go service to service).
   */
  async policyInForce(tx: Tx): Promise<EffectivePolicy> {
    return this.effective(await this.policies.get(tx));
  }

  /** The whole policy as it applies now (defaults filled in); `version` is 0 when nothing is customised. */
  effective(record: PolicyRecord | null): EffectivePolicy {
    const storedThresholds = record ? readThresholds(record.exposureThresholds) : null;
    const thresholds = storedThresholds ?? thresholdsOf(EXPOSURE_V1.defaultBands);
    const dueDays = (record && readDueDays(record.remediationDueDays)) || DEFAULT_DUE_DAYS;
    const planWindow = (record && readPlanWindow(record.planWindowDays)) || {
      minDays: DEFAULT_PLAN_WINDOW.minDays,
      maxDays: DEFAULT_PLAN_WINDOW.maxDays,
    };
    return {
      bands: storedThresholds ? bandsFrom(EXPOSURE_V1, storedThresholds) : EXPOSURE_V1.defaultBands,
      thresholds,
      customisedBands: storedThresholds !== null,
      dueDays,
      customisedDueDays: readDueDays(record?.remediationDueDays) !== null,
      planWindow,
      customisedPlanWindow: readPlanWindow(record?.planWindowDays) !== null,
      version: record?.version ?? 0,
    };
  }

  private toDto(record: PolicyRecord | null): ScoringDto {
    const policy = this.effective(record);
    return {
      exposure: {
        id: EXPOSURE_V1.id,
        version: EXPOSURE_V1.version,
        label: EXPOSURE_V1.label,
        formula: EXPOSURE_V1.formula,
        rangeMin: EXPOSURE_V1.range.min,
        rangeMax: EXPOSURE_V1.range.max,
        bands: [...policy.bands],
        defaultBands: [...EXPOSURE_V1.defaultBands],
        thresholds: policy.thresholds,
        customised: policy.customisedBands,
        attainableValues: attainableExposureValues(),
      },
      maturityLevels: labelsOf(MATURITY_LABELS),
      sensitivityLevels: labelsOf(SENSITIVITY_LABELS),
      severityLevels: labelsOf(SEVERITY_LABELS),
      likelihoodLevels: labelsOf(LIKELIHOOD_LABELS),
      remediationDueDays: policy.dueDays,
      defaultRemediationDueDays: DEFAULT_DUE_DAYS,
      customisedRemediationDueDays: policy.customisedDueDays,
      planWindowDays: policy.planWindow,
      defaultPlanWindowDays: {
        minDays: DEFAULT_PLAN_WINDOW.minDays,
        maxDays: DEFAULT_PLAN_WINDOW.maxDays,
      },
      customisedPlanWindowDays: policy.customisedPlanWindow,
      urgencyQuestions: URGENCY_QUESTIONS.map((question) => ({ ...question })),
      importanceQuestions: IMPORTANCE_QUESTIONS.map((question) => ({ ...question })),
      quadrants: QUADRANTS.map((key) => ({ key, ...QUADRANT_INFO[key] })),
      version: policy.version,
      disclaimer: SCORING_DISCLAIMER,
    };
  }

  /**
   * Omit a field to keep it, send `null` to return that part to the reference default. The row is created on
   * the first change (version 1) and every later change carries the version back.
   */
  async update(dto: UpdateScoringDto): Promise<ScoringDto> {
    return this.uow.run(async (tx) => {
      const current = await this.policies.get(tx);
      if ((current?.version ?? 0) !== dto.version) throw versionConflict();

      const errors: FieldError[] = [];
      if (dto.exposureThresholds !== undefined && dto.exposureThresholds !== null) {
        for (const problem of validateThresholds(EXPOSURE_V1, dto.exposureThresholds)) {
          errors.push({
            path: `exposureThresholds.${problem.field}`,
            code: 'invalidThreshold',
            message: problem.message,
          });
        }
      }
      if (dto.planWindowDays !== undefined && dto.planWindowDays !== null) {
        if (dto.planWindowDays.minDays > dto.planWindowDays.maxDays) {
          errors.push({
            path: 'planWindowDays.maxDays',
            code: 'windowEndsBeforeStart',
            message: 'The window must end on or after the day it starts.',
          });
        }
      }
      if (errors.length > 0) throw invalid(errors);

      const changes: PolicyChanges = {};
      // Named fields, not a spread: what is stored is exactly the four numbers that were validated.
      const thresholds = dto.exposureThresholds;
      if (thresholds !== undefined) {
        changes.exposureThresholds = thresholds
          ? {
              lowMax: thresholds.lowMax,
              mediumMax: thresholds.mediumMax,
              highMax: thresholds.highMax,
            }
          : null;
      }
      const dueDays = dto.remediationDueDays;
      if (dueDays !== undefined) {
        changes.remediationDueDays = dueDays
          ? {
              CRITICAL: dueDays.CRITICAL,
              HIGH: dueDays.HIGH,
              MEDIUM: dueDays.MEDIUM,
              LOW: dueDays.LOW,
            }
          : null;
      }
      const window = dto.planWindowDays;
      if (window !== undefined) {
        changes.planWindowDays = window
          ? { minDays: window.minDays, maxDays: window.maxDays }
          : null;
      }
      if (Object.keys(changes).length === 0) return this.toDto(current);

      const record = current
        ? await this.applyUpdate(tx, current, changes)
        : await this.policies.create(tx, changes);
      await this.audit.record(tx, {
        action: 'scoring_policy.updated',
        entityType: 'assessment_policy',
        entityId: record.id,
        // field names only: the values are public reference data anyway, but the trail stays clean
        changes: Object.fromEntries(Object.keys(changes).map((field) => [field, 'changed'])),
      });
      return this.toDto(record);
    });
  }

  private async applyUpdate(
    tx: Tx,
    current: PolicyRecord,
    changes: PolicyChanges,
  ): Promise<PolicyRecord> {
    const updated = await this.policies.update(tx, current.id, current.version, changes);
    if (!updated) throw versionConflict();
    // The update went through, so the row is exactly this: the same fields, one version higher.
    return { ...current, ...changes, version: current.version + 1 };
  }
}
