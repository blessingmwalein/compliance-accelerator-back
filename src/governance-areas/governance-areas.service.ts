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
  UpdateGovernanceAreaDto,
} from './governance-areas.dto.js';
import {
  GovernanceAreasRepository,
  type GovernanceAreaFields,
  type GovernanceAreaRecord,
} from './governance-areas.repository.js';

const toDto = (record: GovernanceAreaRecord): GovernanceAreaDto => ({
  id: record.id,
  name: record.name,
  description: record.description,
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
        };
        await this.assertFree(tx, fields.name);
        const created = await this.areas.create(tx, fields);
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
        if (Object.keys(changes).length === 0) return toDto(current);

        if (changes.name !== undefined) await this.assertFree(tx, changes.name, id);
        if (!(await this.areas.update(tx, id, dto.version, changes))) throw versionConflict();
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
}
