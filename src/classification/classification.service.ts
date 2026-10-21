import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { isUniqueViolation } from '../common/errors/unique-violation.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { todayIn } from '../domain/remediation/policy.js';
import { toDateOnly, utcDay } from '../domain/registers/review.js';
import type {
  ClassificationLevelDto,
  ClassificationLevelListQueryDto,
  ClassificationLevelPageDto,
  ClassificationLevelVersionDto,
  ClassificationSummaryDto,
  CreateClassificationLevelDto,
  UpdateClassificationLevelDto,
} from './classification.dto.js';
import {
  ClassificationRepository,
  type LevelFields,
  type LevelRecord,
} from './classification.repository.js';

const toDto = (record: LevelRecord): ClassificationLevelDto => ({
  id: record.id,
  name: record.name,
  rank: record.rank,
  description: record.description,
  handlingGuidance: record.handlingGuidance,
  tier: record.tier,
  posture: record.posture,
  retentionPeriod: record.retentionPeriod,
  encryptionRequired: record.encryptionRequired,
  ownerMembershipId: record.ownerMembershipId,
  ownerName: record.owner?.user.fullName ?? null,
  lastReviewDate: toDateOnly(record.lastReviewDate),
  nextReviewDate: toDateOnly(record.nextReviewDate),
  archived: record.archivedAt !== null,
  archivedAt: record.archivedAt?.toISOString() ?? null,
  version: record.version,
});

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Classification level not found.');
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This classification level was changed by someone else. Reload and try again.',
  );
const nameTaken = () =>
  new AppException(
    ErrorCode.ClassificationLevelNameTaken,
    HttpStatus.CONFLICT,
    'Another active classification level already has this name.',
  );
const rankTaken = () =>
  new AppException(
    ErrorCode.ClassificationRankTaken,
    HttpStatus.CONFLICT,
    'That rank is already used in this scheme, and a retired rank is never handed out again.',
  );
const inUse = (count: number) =>
  new AppException(
    ErrorCode.RecordInUse,
    HttpStatus.CONFLICT,
    `This level classifies ${count} active record${count === 1 ? '' : 's'}. ` +
      'Move those to another level first.',
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );

/**
 * The organisation's data classification scheme. Levels are archived, never deleted: a record classified
 * "Restricted" three years ago has to keep reading that way. `rank` is the position in the scheme and is
 * unique per organisation INCLUDING archived levels, so a retired rank is never reused and an old
 * record's place in the order cannot shift under anyone. Nothing is seeded — an organisation with no
 * levels has no scheme yet, which is a fact the UI shows rather than a default it hides.
 */
@Injectable()
export class ClassificationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly levels: ClassificationRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(query: ClassificationLevelListQueryDto): Promise<ClassificationLevelPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.levels.list(tx, {
        limit,
        includeArchived: query.includeArchived === true,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.tier ? { tier: query.tier } : {}),
      }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  /**
   * The coverage figures the register is judged on, counted over every live level rather than over one page
   * of the list. A level nobody tagged belongs to no tier and states no posture, so the tier and exposure
   * counts are not a partition of `total` and are never presented as one.
   */
  summary(): Promise<ClassificationSummaryDto> {
    return this.uow.run(async (tx) => {
      const today = todayIn(await this.levels.timezone(tx), this.clock.now());
      const rows = await this.levels.liveCoverageRows(tx);
      return {
        // no levels is not "a scheme of nothing": it is an organisation that has not classified its data yet
        availability: rows.length === 0 ? ('no_scheme' as const) : ('ok' as const),
        asOf: today,
        total: rows.length,
        restricted: rows.filter((row) => row.tier === 'RESTRICTED').length,
        confidential: rows.filter((row) => row.tier === 'CONFIDENTIAL').length,
        highExposure: rows.filter((row) => row.posture === 'HIGH' || row.posture === 'CRITICAL')
          .length,
      };
    });
  }

  /** `rank` may be omitted: the level is then appended after the highest rank in the scheme. */
  async create(dto: CreateClassificationLevelDto): Promise<ClassificationLevelDto> {
    try {
      return await this.uow.run(async (tx) => {
        const fields: LevelFields = {
          name: dto.name,
          rank: dto.rank ?? (await this.levels.maxRank(tx)) + 1,
          description: dto.description ?? null,
          handlingGuidance: dto.handlingGuidance ?? null,
          tier: dto.tier ?? null,
          posture: dto.posture ?? null,
          retentionPeriod: dto.retentionPeriod ?? null,
          encryptionRequired: dto.encryptionRequired === true,
          ownerMembershipId: dto.ownerMembershipId ?? null,
          lastReviewDate: dto.lastReviewDate ? utcDay(dto.lastReviewDate) : null,
          nextReviewDate: dto.nextReviewDate ? utcDay(dto.nextReviewDate) : null,
        };
        this.assertDates(fields);
        await this.assertFree(tx, { name: fields.name, rank: fields.rank });
        await this.assertOwner(tx, fields.ownerMembershipId);
        const created = await this.levels.create(tx, fields);
        await this.audit.record(tx, {
          action: 'classification_level.created',
          entityType: 'classification_level',
          entityId: created.id,
          entityLabel: created.name,
          changes: { rank: created.rank },
        });
        return toDto(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(); // a concurrent request won the name race
      throw error;
    }
  }

  async update(id: string, dto: UpdateClassificationLevelDto): Promise<ClassificationLevelDto> {
    try {
      return await this.uow.run(async (tx) => {
        const current = await this.mustFind(tx, id);
        if (current.version !== dto.version) throw versionConflict();
        if (current.archivedAt) {
          throw new AppException(
            ErrorCode.Conflict,
            HttpStatus.CONFLICT,
            'An archived classification level cannot be edited. Restore it first.',
          );
        }

        const changes: Partial<LevelFields> = {};
        const audited: Record<string, unknown> = {};
        if (dto.name !== undefined && dto.name !== current.name) {
          changes.name = dto.name;
          audited.name = { from: current.name, to: dto.name };
        }
        if (dto.rank !== undefined && dto.rank !== current.rank) {
          changes.rank = dto.rank;
          audited.rank = { from: current.rank, to: dto.rank };
        }
        for (const key of ['description', 'handlingGuidance', 'retentionPeriod'] as const) {
          const next = dto[key];
          if (next !== undefined && next !== current[key]) {
            changes[key] = next;
            audited[key] = { from: current[key], to: next };
          }
        }
        // a tier or a posture sent as null clears the tag: the level goes back to "nobody said"
        if (dto.tier !== undefined && dto.tier !== current.tier) {
          changes.tier = dto.tier ?? null;
          audited.tier = { from: current.tier, to: dto.tier ?? null };
        }
        if (dto.posture !== undefined && dto.posture !== current.posture) {
          changes.posture = dto.posture ?? null;
          audited.posture = { from: current.posture, to: dto.posture ?? null };
        }
        if (
          dto.encryptionRequired !== undefined &&
          dto.encryptionRequired !== current.encryptionRequired
        ) {
          changes.encryptionRequired = dto.encryptionRequired;
          audited.encryptionRequired = {
            from: current.encryptionRequired,
            to: dto.encryptionRequired,
          };
        }
        if (
          dto.ownerMembershipId !== undefined &&
          dto.ownerMembershipId !== current.ownerMembershipId
        ) {
          changes.ownerMembershipId = dto.ownerMembershipId;
          audited.ownerMembershipId = 'changed'; // a person's name is not copied into the audit trail
        }
        for (const key of ['lastReviewDate', 'nextReviewDate'] as const) {
          const next = dto[key];
          if (next === undefined) continue;
          const asDate = next ? utcDay(next) : null;
          if (toDateOnly(asDate) !== toDateOnly(current[key])) {
            changes[key] = asDate;
            audited[key] = { from: toDateOnly(current[key]), to: next };
          }
        }
        if (Object.keys(changes).length === 0) return toDto(current);

        this.assertDates({
          lastReviewDate:
            'lastReviewDate' in changes ? (changes.lastReviewDate ?? null) : current.lastReviewDate,
          nextReviewDate:
            'nextReviewDate' in changes ? (changes.nextReviewDate ?? null) : current.nextReviewDate,
        });
        await this.assertFree(tx, {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          rank: changes.rank ?? null,
          exceptId: id,
        });
        if ('ownerMembershipId' in changes) {
          await this.assertOwner(tx, changes.ownerMembershipId ?? null);
        }
        if (!(await this.levels.update(tx, id, dto.version, changes))) throw versionConflict();
        await this.audit.record(tx, {
          action: 'classification_level.updated',
          entityType: 'classification_level',
          entityId: id,
          entityLabel: changes.name ?? current.name,
          changes: audited,
        });
        const fresh = await this.levels.findById(tx, id); // the owner's name may have changed
        return toDto(fresh ?? { ...current, ...changes, version: current.version + 1 });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw await this.whichClash(dto.name, dto.rank);
      throw error;
    }
  }

  /** Archives the level: hidden from pickers, kept for history. Idempotent, and refused while in use. */
  archive(id: string, dto: ClassificationLevelVersionDto): Promise<ClassificationLevelDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.archivedAt) return toDto(current); // already archived: idempotent
      if (current.version !== dto.version) throw versionConflict();
      const used = await this.levels.countReferences(tx, id);
      if (used > 0) throw inUse(used);
      const archivedAt = this.clock.now();
      if (!(await this.levels.update(tx, id, dto.version, { archivedAt }))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'classification_level.archived',
        entityType: 'classification_level',
        entityId: id,
        entityLabel: current.name,
      });
      return toDto({ ...current, archivedAt, version: current.version + 1 });
    });
  }

  async unarchive(id: string, dto: ClassificationLevelVersionDto): Promise<ClassificationLevelDto> {
    try {
      return await this.uow.run(async (tx) => {
        const current = await this.mustFind(tx, id);
        if (!current.archivedAt) return toDto(current);
        if (current.version !== dto.version) throw versionConflict();
        // another level may have taken the name while this one was archived (its rank stays reserved)
        await this.assertFree(tx, { name: current.name, exceptId: id });
        if (!(await this.levels.update(tx, id, dto.version, { archivedAt: null }))) {
          throw versionConflict();
        }
        await this.audit.record(tx, {
          action: 'classification_level.unarchived',
          entityType: 'classification_level',
          entityId: id,
          entityLabel: current.name,
        });
        return toDto({ ...current, archivedAt: null, version: current.version + 1 });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  // ---- the checks, all of them here and none of them in the controller

  private async mustFind(tx: Tx, id: string): Promise<LevelRecord> {
    const level = await this.levels.findById(tx, id);
    if (!level) throw notFound();
    return level;
  }

  /** The friendly pre-check (the unique indexes are the guarantee). */
  private async assertFree(
    tx: Tx,
    want: { name?: string; rank?: number | null; exceptId?: string },
  ): Promise<void> {
    if (
      want.name !== undefined &&
      (await this.levels.findActiveByName(tx, want.name, want.exceptId))
    ) {
      throw nameTaken();
    }
    if (want.rank !== null && want.rank !== undefined) {
      if (await this.levels.findByRank(tx, want.rank, want.exceptId)) throw rankTaken();
    }
  }

  /** The owner must be an ACTIVE member of this organisation (as a business unit's head must be). */
  private async assertOwner(tx: Tx, ownerMembershipId: string | null): Promise<void> {
    if (ownerMembershipId && !(await this.levels.isActiveMember(tx, ownerMembershipId))) {
      throw invalid(
        'ownerMembershipId',
        'notAnActiveMember',
        'The owner must be an active member of this organisation.',
      );
    }
  }

  /**
   * A review dated after the next review is a mistake, not a state: say which field. Both dates are
   * `YYYY-MM-DD` here, so comparing the strings compares the calendar days.
   */
  private assertDates(fields: { lastReviewDate: Date | null; nextReviewDate: Date | null }): void {
    const last = toDateOnly(fields.lastReviewDate);
    const next = toDateOnly(fields.nextReviewDate);
    if (last && next && next <= last) {
      throw invalid(
        'nextReviewDate',
        'notAfterLastReview',
        'The next review must be on a later day than the last review.',
      );
    }
  }

  /** Which unique index the request hit when two people wrote at the same moment. */
  private async whichClash(
    name: string | undefined,
    rank: number | undefined,
  ): Promise<AppException> {
    const { byName, byRank } = await this.uow.run(async (tx) => ({
      byName: name === undefined ? null : await this.levels.findActiveByName(tx, name),
      byRank: rank === undefined ? null : await this.levels.findByRank(tx, rank),
    }));
    if (byRank) return rankTaken();
    if (byName) return nameTaken();
    return rank === undefined ? nameTaken() : rankTaken();
  }
}
