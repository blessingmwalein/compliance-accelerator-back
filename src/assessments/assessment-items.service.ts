import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  AssessmentTemplatesService,
  TEMPLATE_DISCLAIMER,
} from '../assessment-templates/assessment-templates.service.js';
import { AppException, ErrorCode, type FieldError } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { scoreItem } from '../domain/scoring/scoring.js';
import { SCORING_DISCLAIMER } from '../scoring/scoring.service.js';
import { RequestContext } from '../tenancy/request-context.js';
import { bandsOf, dateOnlyOf, dateOnlyToValue } from './assessment-snapshot.js';
import {
  AssessmentItemsRepository,
  type ItemChanges,
  type ItemRecord,
  type ItemSubject,
} from './assessment-items.repository.js';
import { AssessmentsRepository, type AssessmentRecord } from './assessments.repository.js';
import type {
  ApplyTemplateResultDto,
  AssessmentItemDto,
  AssessmentItemListQueryDto,
  AssessmentItemPageDto,
  CreateAssessmentItemDto,
  ItemEvidenceDto,
  UpdateAssessmentItemDto,
} from './assessments.dto.js';

type RatingKey = 'currentMaturity' | 'targetMaturity' | 'sensitivity' | 'severity' | 'likelihood';
const RATING_KEYS: readonly RatingKey[] = [
  'currentMaturity',
  'targetMaturity',
  'sensitivity',
  'severity',
  'likelihood',
];
const DERIVED_KEYS = ['gap', 'exposure', 'riskLevel'] as const;

const UNRATED: Record<RatingKey, number | null> = {
  currentMaturity: null,
  targetMaturity: null,
  sensitivity: null,
  severity: null,
  likelihood: null,
};

const itemNotFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Assessment item not found.');

const assessmentNotFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Assessment not found.');

const assessmentNotEditable = () =>
  new AppException(
    ErrorCode.AssessmentNotEditable,
    HttpStatus.CONFLICT,
    'Only a draft assessment can be changed. Submit it for review, or revise the approved cycle.',
  );

const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This item was changed by someone else. Reload and try again.',
  );

const subjectExists = () =>
  new AppException(
    ErrorCode.AssessmentItemExists,
    HttpStatus.CONFLICT,
    'This assessment already has an item for the same subject.',
  );

const invalid = (errors: FieldError[]) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    errors,
  );

const needActor = (actorUserId: string | undefined): string => {
  if (!actorUserId) throw new Error('Assessment work needs a signed-in actor');
  return actorUserId;
};

const labelOf = (item: ItemRecord): string =>
  item.governanceAreaName ?? item.requirementRef ?? item.id;

/** A stored item plus the evidence attached to it becomes the DTO the client sees. */
const toItemDto = (item: ItemRecord, evidenceIds: readonly string[]): AssessmentItemDto => ({
  id: item.id,
  assessmentId: item.assessmentId,
  governanceAreaId: item.governanceAreaId,
  governanceAreaName: item.governanceAreaName,
  requirementId: item.requirementId,
  requirementRef: item.requirementRef,
  frameworkId: item.frameworkId,
  frameworkCode: item.frameworkCode,
  businessUnitId: item.businessUnitId,
  businessUnitName: item.businessUnitName,
  currentMaturity: item.currentMaturity,
  targetMaturity: item.targetMaturity,
  sensitivity: item.sensitivity,
  severity: item.severity,
  likelihood: item.likelihood,
  gap: item.gap,
  exposure: item.exposure,
  riskLevel: item.riskLevel,
  rationale: item.rationale,
  findings: item.findings,
  ownerMembershipId: item.ownerMembershipId,
  ownerName: item.ownerName,
  lastReviewDate: dateOnlyOf(item.lastReviewDate),
  nextReviewDate: dateOnlyOf(item.nextReviewDate),
  evidenceIds: [...evidenceIds],
  version: item.version,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
});

const subjectOf = (item: ItemRecord): ItemSubject => ({
  governanceAreaId: item.governanceAreaId,
  requirementId: item.requirementId,
  businessUnitId: item.businessUnitId,
  frameworkId: item.frameworkId,
});

const sameSubject = (a: ItemSubject, b: ItemSubject): boolean =>
  a.governanceAreaId === b.governanceAreaId &&
  a.requirementId === b.requirementId &&
  a.businessUnitId === b.businessUnitId &&
  a.frameworkId === b.frameworkId;

const sameRatings = (ratings: Record<RatingKey, number | null>, item: ItemRecord): boolean =>
  RATING_KEYS.every((key) => ratings[key] === item[key]);

/** The ratings a PATCH leaves: a missing field keeps its value, `null` means "not assessed" again. */
function ratingsAfter(
  sent: CreateAssessmentItemDto | UpdateAssessmentItemDto,
  keep: Record<RatingKey, number | null>,
): Record<RatingKey, number | null> {
  const out = { ...keep };
  for (const key of RATING_KEYS) {
    const value = sent[key];
    if (value === undefined) continue;
    out[key] = value === null ? null : (value as number);
  }
  return out;
}

/** Numbers for the derived columns, everything else named: a finding can carry personal data. */
function auditOf(changes: ItemChanges): Record<string, unknown> {
  const audited: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(changes)) {
    audited[field] =
      RATING_KEYS.includes(field as RatingKey) ||
      (DERIVED_KEYS as readonly string[]).includes(field)
        ? value
        : 'changed';
  }
  return audited;
}

/**
 * The items of an assessment: what was rated, what the methodology derives from it, and the evidence attached.
 *
 * A missing rating is never a default (grc-domain rule 3): `gap`, `exposure` and `riskLevel` are `NULL` unless
 * every factor is rated, and they are computed on the server from the item's OWN assessment's band snapshot and
 * then stored, so an approved item reads the same forever even after the organisation changes its bands.
 */
@Injectable()
export class AssessmentItemsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly items: AssessmentItemsRepository,
    private readonly assessments: AssessmentsRepository,
    private readonly templates: AssessmentTemplatesService,
    private readonly audit: AuditService,
    private readonly requestContext: RequestContext,
  ) {}

  async list(
    assessmentId: string,
    query: AssessmentItemListQueryDto,
  ): Promise<AssessmentItemPageDto> {
    const limit = pageSizeOf(query);
    const { page, byItem } = await this.uow.run(async (tx) => {
      if (!(await this.assessments.findById(tx, assessmentId))) throw assessmentNotFound();
      const rows = await this.items.list(tx, {
        assessmentId,
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
        ...(query.frameworkId ? { frameworkId: query.frameworkId } : {}),
        ...(query.governanceAreaId ? { governanceAreaId: query.governanceAreaId } : {}),
        ...(query.ratedOnly ? { ratedOnly: true } : {}),
      });
      const paged = toPage(rows, limit);
      return {
        page: paged,
        byItem: await this.items.evidenceIdsByItem(
          tx,
          paged.items.map((item) => item.id),
        ),
      };
    });
    return {
      items: page.items.map((item) => toItemDto(item, byItem.get(item.id) ?? [])),
      nextCursor: page.nextCursor,
    };
  }

  async get(itemId: string): Promise<AssessmentItemDto> {
    return this.uow.run(async (tx) => {
      const item = await this.items.findById(tx, itemId);
      if (!item) throw itemNotFound();
      return toItemDto(item, await this.items.evidenceIdsOf(tx, itemId));
    });
  }

  async create(assessmentId: string, dto: CreateAssessmentItemDto): Promise<AssessmentItemDto> {
    return this.uow.run(async (tx) => {
      const assessment = await this.editableDraft(tx, assessmentId);
      const subject = await this.resolveSubject(tx, dto);
      if (await this.items.findBySubject(tx, assessmentId, subject)) throw subjectExists();

      const ratings = ratingsAfter(dto, UNRATED);
      const derived = scoreItem(ratings, bandsOf(assessment.exposureBands));
      const created = await this.items.create(tx, {
        assessmentId,
        ...subject,
        ...ratings,
        gap: derived.gap,
        exposure: derived.exposure,
        riskLevel: derived.riskLevel,
        rationale: dto.rationale ?? null,
        findings: dto.findings ?? null,
        ownerMembershipId: dto.ownerMembershipId ?? null,
        lastReviewDate: dateOnlyToValue(dto.lastReviewDate),
        nextReviewDate: dateOnlyToValue(dto.nextReviewDate),
      });
      await this.audit.record(tx, {
        action: 'assessment_item.created',
        entityType: 'assessment_item',
        entityId: created.id,
        entityLabel: labelOf(created),
        changes: { assessmentId, ...derived },
      });
      return toItemDto(created, []);
    });
  }

  async update(itemId: string, dto: UpdateAssessmentItemDto): Promise<AssessmentItemDto> {
    return this.uow.run(async (tx) => {
      const current = await this.items.findById(tx, itemId);
      if (!current) throw itemNotFound();
      const assessment = await this.editableDraft(tx, current.assessmentId);
      if (current.version !== dto.version) throw versionConflict();

      const errors: FieldError[] = [];
      for (const field of ['governanceAreaId', 'requirementId', 'frameworkId'] as const) {
        if (dto[field] === null) {
          errors.push({
            path: field,
            code: 'cannotClearSubject',
            message: `What an item is about cannot be cleared: send an id or leave the field out.`,
          });
        }
      }
      if (errors.length > 0) throw invalid(errors);

      const proposed: ItemSubject = {
        governanceAreaId: dto.governanceAreaId ?? current.governanceAreaId,
        requirementId: dto.requirementId ?? current.requirementId,
        businessUnitId:
          dto.businessUnitId === null ? null : (dto.businessUnitId ?? current.businessUnitId),
        frameworkId: dto.frameworkId ?? current.frameworkId,
      };
      const subject = await this.resolveSubject(tx, proposed);

      const changes: ItemChanges = {};
      if (!sameSubject(subject, subjectOf(current))) {
        if (await this.items.findBySubject(tx, current.assessmentId, subject))
          throw subjectExists();
        Object.assign(changes, subject);
      }

      const ratings = ratingsAfter(dto, {
        currentMaturity: current.currentMaturity,
        targetMaturity: current.targetMaturity,
        sensitivity: current.sensitivity,
        severity: current.severity,
        likelihood: current.likelihood,
      });
      const derived = scoreItem(ratings, bandsOf(assessment.exposureBands));
      const rescored = !sameRatings(ratings, current);
      if (rescored) Object.assign(changes, ratings, derived);

      for (const field of ['rationale', 'findings'] as const) {
        if (dto[field] !== undefined && dto[field] !== current[field]) changes[field] = dto[field];
      }
      if (
        dto.ownerMembershipId !== undefined &&
        dto.ownerMembershipId !== current.ownerMembershipId
      ) {
        if (dto.ownerMembershipId === null) {
          changes.ownerMembershipId = null;
        } else {
          const member = await this.items.activeMembership(tx, dto.ownerMembershipId);
          if (!member) {
            throw invalid([
              {
                path: 'ownerMembershipId',
                code: 'notAnActiveMember',
                message: 'The owner must be an active member of this organisation.',
              },
            ]);
          }
          changes.ownerMembershipId = member.id;
        }
      }
      for (const field of ['lastReviewDate', 'nextReviewDate'] as const) {
        if (dto[field] === undefined) continue;
        const next = dateOnlyToValue(dto[field]);
        if ((current[field]?.getTime() ?? null) !== (next?.getTime() ?? null))
          changes[field] = next;
      }

      if (Object.keys(changes).length === 0) {
        return toItemDto(current, await this.items.evidenceIdsOf(tx, itemId));
      }
      if (!(await this.items.update(tx, itemId, dto.version, changes))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'assessment_item.updated',
        entityType: 'assessment_item',
        entityId: itemId,
        entityLabel: labelOf(current),
        changes: auditOf(changes),
      });
      return this.readItem(tx, itemId);
    });
  }

  remove(itemId: string): Promise<void> {
    return this.uow.run(async (tx) => {
      const current = await this.items.findById(tx, itemId);
      if (!current) throw itemNotFound();
      await this.editableDraft(tx, current.assessmentId);
      if (!(await this.items.remove(tx, itemId))) throw itemNotFound();
      await this.audit.record(tx, {
        action: 'assessment_item.deleted',
        entityType: 'assessment_item',
        entityId: itemId,
        entityLabel: labelOf(current),
        changes: { assessmentId: current.assessmentId },
      });
    });
  }

  /** Attaches an evidence file of this organisation to the item. Linking it twice changes nothing. */
  linkEvidence(itemId: string, evidenceId: string): Promise<ItemEvidenceDto> {
    const actorUserId = needActor(this.requestContext.actorUserId);
    return this.uow.run(async (tx) => {
      const item = await this.items.findById(tx, itemId);
      if (!item) throw itemNotFound();
      await this.editableDraft(tx, item.assessmentId);
      if (!(await this.items.existingEvidenceIds(tx, [evidenceId])).has(evidenceId)) {
        throw invalid([
          {
            path: 'evidenceId',
            code: 'unknownEvidence',
            message: 'Attach a file this organisation has uploaded.',
          },
        ]);
      }
      if (await this.items.linkEvidence(tx, itemId, evidenceId, actorUserId)) {
        await this.audit.record(tx, {
          action: 'assessment_item.evidence_linked',
          entityType: 'assessment_item',
          entityId: itemId,
          entityLabel: labelOf(item),
          changes: { evidenceId },
        });
      }
      return { itemId, evidenceIds: await this.items.evidenceIdsOf(tx, itemId) };
    });
  }

  unlinkEvidence(itemId: string, evidenceId: string): Promise<ItemEvidenceDto> {
    return this.uow.run(async (tx) => {
      const item = await this.items.findById(tx, itemId);
      if (!item) throw itemNotFound();
      await this.editableDraft(tx, item.assessmentId);
      if (await this.items.unlinkEvidence(tx, itemId, evidenceId)) {
        await this.audit.record(tx, {
          action: 'assessment_item.evidence_unlinked',
          entityType: 'assessment_item',
          entityId: itemId,
          entityLabel: labelOf(item),
          changes: { evidenceId },
        });
      }
      return { itemId, evidenceIds: await this.items.evidenceIdsOf(tx, itemId) };
    });
  }

  /**
   * Applies a published quick-start template to a draft assessment (AC-GOV-01): one item per subject, in the
   * template's order, with every rating left unassessed. An area the organisation already has is reused; a
   * subject it already assesses is skipped. Applying the same template twice therefore adds nothing twice.
   */
  async applyTemplate(assessmentId: string, templateId: string): Promise<ApplyTemplateResultDto> {
    return this.uow.run(async (tx) => {
      const assessment = await this.editableDraft(tx, assessmentId);
      const found = await this.templates.loadForApply(tx, templateId);
      if (!found) {
        throw invalid([
          {
            path: 'templateId',
            code: 'unknownTemplate',
            message: 'No published quick-start template has this id.',
          },
        ]);
      }

      const created: ItemRecord[] = [];
      const createdAreaNames: string[] = [];
      let skipped = 0;
      for (const templateItem of found.items) {
        const existing = await this.items.findActiveAreaByName(tx, templateItem.areaName);
        const area =
          existing ??
          (await this.items.createArea(tx, templateItem.areaName, templateItem.areaReference));
        if (!existing) createdAreaNames.push(area.name);

        const itemSubject: ItemSubject = {
          governanceAreaId: area.id,
          requirementId: null,
          businessUnitId: null,
          frameworkId: null,
        };
        if (await this.items.findBySubject(tx, assessmentId, itemSubject)) {
          skipped += 1;
          continue;
        }
        created.push(
          await this.items.create(tx, {
            assessmentId,
            ...itemSubject,
            ...UNRATED,
            gap: null,
            exposure: null,
            riskLevel: null,
            rationale: null,
            findings: null,
            ownerMembershipId: null,
            lastReviewDate: null,
            nextReviewDate: null,
          }),
        );
      }

      await this.audit.record(tx, {
        action: 'assessment_item.bulk_created',
        entityType: 'assessment',
        entityId: assessmentId,
        entityLabel: assessment.title,
        changes: {
          templateId,
          templateVersion: found.template.templateVersion,
          inserted: created.length,
          skipped,
          createdAreaCount: createdAreaNames.length,
        },
      });
      return {
        items: created.map((item) => toItemDto(item, [])),
        inserted: created.length,
        skipped,
        createdAreaNames,
        disclaimer: `${TEMPLATE_DISCLAIMER} ${SCORING_DISCLAIMER}`,
      };
    });
  }

  /** The assessment must exist and be a DRAFT: an item of a submitted or approved cycle is history. */
  private async editableDraft(tx: Tx, assessmentId: string): Promise<AssessmentRecord> {
    const assessment = await this.assessments.findById(tx, assessmentId);
    if (!assessment) throw assessmentNotFound();
    if (assessment.status !== 'DRAFT') throw assessmentNotEditable();
    return assessment;
  }

  private async readItem(tx: Tx, itemId: string): Promise<AssessmentItemDto> {
    const item = await this.items.findById(tx, itemId);
    if (!item) throw itemNotFound();
    return toItemDto(item, await this.items.evidenceIdsOf(tx, itemId));
  }

  /** Every reference an item points at must be real for THIS organisation, and framework content usable. */
  private async resolveSubject(tx: Tx, subject: Partial<ItemSubject>): Promise<ItemSubject> {
    const errors: FieldError[] = [];
    const governanceAreaId = subject.governanceAreaId ?? null;
    const requirementId = subject.requirementId ?? null;
    const businessUnitId = subject.businessUnitId ?? null;
    const frameworkId = subject.frameworkId ?? null;

    if (governanceAreaId === null && requirementId === null) {
      errors.push({
        path: 'governanceAreaId',
        code: 'subjectRequired',
        message: 'An item needs a governance area, a framework requirement, or both.',
      });
    }
    if (governanceAreaId) {
      const area = await this.items.activeGovernanceArea(tx, governanceAreaId);
      if (!area) {
        errors.push({
          path: 'governanceAreaId',
          code: 'unknownArea',
          message: 'Choose one of this organisation’s active governance areas.',
        });
      }
    }
    let requirementFrameworkId: string | null = null;
    if (requirementId) {
      const requirement = await this.items.usableRequirement(tx, requirementId);
      if (!requirement) {
        errors.push({
          path: 'requirementId',
          code: 'requirementUnavailable',
          message:
            'Choose a requirement of a verified framework version; framework content is loaded by the platform owner.',
        });
      } else {
        requirementFrameworkId = requirement.frameworkId;
      }
    }
    if (businessUnitId) {
      const unit = await this.items.activeBusinessUnit(tx, businessUnitId);
      if (!unit) {
        errors.push({
          path: 'businessUnitId',
          code: 'unknownBusinessUnit',
          message: 'Choose one of this organisation’s active business units.',
        });
      }
    }
    if (frameworkId) {
      const framework = await this.items.applicableFramework(tx, frameworkId);
      if (!framework) {
        errors.push({
          path: 'frameworkId',
          code: 'frameworkNotApplicable',
          message: 'This framework is not in the organisation’s applicable set (Company Settings).',
        });
      } else if (requirementFrameworkId && requirementFrameworkId !== framework.id) {
        errors.push({
          path: 'frameworkId',
          code: 'notRequirementFramework',
          message: 'The cited requirement belongs to another framework.',
        });
      }
    }
    if (errors.length > 0) throw invalid(errors);
    return { governanceAreaId, requirementId, businessUnitId, frameworkId };
  }
}
