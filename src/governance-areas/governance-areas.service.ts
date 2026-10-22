import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { isUniqueViolation } from '../common/errors/unique-violation.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type {
  CreateGovernanceAreaDto,
  GovernanceAreaDto,
  GovernanceAreaListQueryDto,
  GovernanceAreaPageDto,
  GovernanceAreaVersionDto,
  MappingNoteInputDto,
  UpdateGovernanceAreaDto,
} from './governance-areas.dto.js';
import {
  GovernanceAreasRepository,
  type AreaNoteField,
  type GovernanceAreaFields,
  type GovernanceAreaRecord,
} from './governance-areas.repository.js';

const toDto = (record: GovernanceAreaRecord): GovernanceAreaDto => ({
  id: record.id,
  name: record.name,
  description: record.description,
  category: record.category,
  controlObjective: record.controlObjective,
  archived: record.archivedAt !== null,
  archivedAt: record.archivedAt?.toISOString() ?? null,
  version: record.version,
});

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Governance area not found.');
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This governance area was changed by someone else. Reload and try again.',
  );
const nameTaken = () =>
  new AppException(
    ErrorCode.GovernanceAreaNameTaken,
    HttpStatus.CONFLICT,
    'Another active governance area already has this name.',
  );
const unknownFramework = (id: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [
      {
        path: 'notes',
        code: 'UNKNOWN_FRAMEWORK',
        message: `No active framework in the catalogue has the id ${id}.`,
      },
    ],
  );

/**
 * Governance areas: the organisation's own topics ("Data subject rights", "Security measures") that
 * mappings, and later assessments, are filed under. They are plain labels chosen by the organisation: the
 * platform ships none, because a ready-made list would be unverified content. Archived, never deleted;
 * names are unique among active areas (also enforced by a unique index).
 */
@Injectable()
export class GovernanceAreasService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly areas: GovernanceAreasRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(query: GovernanceAreaListQueryDto): Promise<GovernanceAreaPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.areas.list(tx, {
        limit,
        includeArchived: query.includeArchived === true,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
      }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async create(dto: CreateGovernanceAreaDto): Promise<GovernanceAreaDto> {
    try {
      return await this.uow.run(async (tx) => {
        const fields: GovernanceAreaFields = {
          name: dto.name,
          description: dto.description ?? null,
          category: dto.category ?? null,
          controlObjective: dto.controlObjective ?? null,
        };
        await this.assertFree(tx, fields.name);
        const notes = await this.assertNotes(tx, dto.notes);
        const created = await this.areas.create(tx, fields);
        await this.areas.replaceNotes(tx, created.id, notes);
        await this.audit.record(tx, {
          action: 'governance_area.created',
          entityType: 'governance_area',
          entityId: created.id,
          entityLabel: created.name,
        });
        return toDto(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(); // a concurrent request won the race
      throw error;
    }
  }

  async update(id: string, dto: UpdateGovernanceAreaDto): Promise<GovernanceAreaDto> {
    try {
      return await this.uow.run(async (tx) => {
        const current = await this.areas.findById(tx, id);
        if (!current) throw notFound();
        if (current.version !== dto.version) throw versionConflict();
        if (current.archivedAt) {
          throw new AppException(
            ErrorCode.Conflict,
            HttpStatus.CONFLICT,
            'An archived governance area cannot be edited. Restore it first.',
          );
        }
        // the notes are validated before anything is written, so a bad framework id writes no label either
        const notes = dto.notes === undefined ? undefined : await this.assertNotes(tx, dto.notes);
        const changes: Partial<GovernanceAreaFields> = {};
        const audited: Record<string, unknown> = {};
        if (dto.name !== undefined && dto.name !== current.name) {
          changes.name = dto.name;
          audited.name = { from: current.name, to: dto.name };
        }
        if (dto.description !== undefined && dto.description !== current.description) {
          changes.description = dto.description;
          audited.description = 'changed';
        }
        if (dto.category !== undefined && dto.category !== current.category) {
          changes.category = dto.category;
          audited.category = 'changed';
        }
        if (
          dto.controlObjective !== undefined &&
          dto.controlObjective !== current.controlObjective
        ) {
          changes.controlObjective = dto.controlObjective;
          audited.controlObjective = 'changed';
        }
        // a `notes` key replaces the row's whole set of cells, so its presence alone is a change
        const cellsChanged = notes !== undefined;
        if (Object.keys(changes).length === 0 && !cellsChanged) return toDto(current);

        if (changes.name !== undefined) await this.assertFree(tx, changes.name, id);
        // The area's version guards the whole sheet, reference cells included, so the row is touched even
        // when only a cell changed: two people editing one row cannot both believe they saved last.
        if (!(await this.areas.update(tx, id, dto.version, changes))) throw versionConflict();
        if (notes !== undefined) {
          await this.areas.replaceNotes(tx, id, notes);
          audited.referenceCells = `${String(notes.filter((note) => note.note !== null).length)} of ${String(notes.length)} stated`;
        }
        await this.audit.record(tx, {
          action: 'governance_area.updated',
          entityType: 'governance_area',
          entityId: id,
          entityLabel: changes.name ?? current.name,
          changes: audited,
        });
        return toDto({ ...current, ...changes, version: current.version + 1 });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /**
   * Clears one row's own reference text: its category, its control objective and every framework cell of
   * it. The area itself and its verified requirement mappings are untouched — an area is archived, never
   * deleted, and a mapping is history. Idempotent: a row with nothing stated has nothing to clear.
   */
  deleteSheet(id: string): Promise<GovernanceAreaDto> {
    return this.uow.run(async (tx) => {
      const current = await this.areas.findById(tx, id);
      if (!current) throw notFound();
      const removed = await this.areas.deleteNotes(tx, id);
      const blank = current.category === null && current.controlObjective === null && removed === 0;
      if (blank) return toDto(current);
      if (
        !(await this.areas.update(tx, id, current.version, {
          category: null,
          controlObjective: null,
        }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'governance_area.sheet_deleted',
        entityType: 'governance_area',
        entityId: id,
        entityLabel: current.name,
        changes: { referenceCells: removed, category: 'cleared', controlObjective: 'cleared' },
      });
      return toDto({
        ...current,
        category: null,
        controlObjective: null,
        version: current.version + 1,
      });
    });
  }

  archive(id: string, dto: GovernanceAreaVersionDto): Promise<GovernanceAreaDto> {
    return this.uow.run(async (tx) => {
      const current = await this.areas.findById(tx, id);
      if (!current) throw notFound();
      if (current.archivedAt) return toDto(current); // already archived: idempotent
      if (current.version !== dto.version) throw versionConflict();
      const archivedAt = this.clock.now();
      if (!(await this.areas.update(tx, id, dto.version, { archivedAt }))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'governance_area.archived',
        entityType: 'governance_area',
        entityId: id,
        entityLabel: current.name,
      });
      return toDto({ ...current, archivedAt, version: current.version + 1 });
    });
  }

  async unarchive(id: string, dto: GovernanceAreaVersionDto): Promise<GovernanceAreaDto> {
    try {
      return await this.uow.run(async (tx) => {
        const current = await this.areas.findById(tx, id);
        if (!current) throw notFound();
        if (!current.archivedAt) return toDto(current);
        if (current.version !== dto.version) throw versionConflict();
        // another area may have taken the name while this one was archived
        await this.assertFree(tx, current.name, id);
        if (!(await this.areas.update(tx, id, dto.version, { archivedAt: null }))) {
          throw versionConflict();
        }
        await this.audit.record(tx, {
          action: 'governance_area.unarchived',
          entityType: 'governance_area',
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

  /** The friendly pre-check (the unique index is the guarantee). */
  private async assertFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
    if (await this.areas.findActiveByName(tx, name, exceptId)) throw nameTaken();
  }

  /**
   * The row's reference cells, with every framework id checked against the catalogue before anything is
   * written: a cell pointing at an unknown or retired framework is refused as a bad request, not dropped in
   * silence, because a cell nobody can see in the table would be a cell nobody can clear.
   */
  private async assertNotes(
    tx: Tx,
    notes: MappingNoteInputDto[] | undefined,
  ): Promise<AreaNoteField[]> {
    if (notes === undefined || notes.length === 0) return [];
    const known = await this.areas.findActiveFrameworkIds(tx, [
      ...new Set(notes.map((note) => note.frameworkId)),
    ]);
    for (const note of notes) {
      if (!known.has(note.frameworkId)) throw unknownFramework(note.frameworkId);
    }
    return notes.map((note) => ({ frameworkId: note.frameworkId, note: note.note ?? null }));
  }
}
