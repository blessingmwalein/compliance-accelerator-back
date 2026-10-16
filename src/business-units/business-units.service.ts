import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { isUniqueViolation } from '../common/errors/unique-violation.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import { Clock } from '../common/clock.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type {
  BusinessUnitDto,
  BusinessUnitListQueryDto,
  BusinessUnitPageDto,
  BusinessUnitVersionDto,
  CreateBusinessUnitDto,
  UpdateBusinessUnitDto,
} from './business-units.dto.js';
import {
  BusinessUnitsRepository,
  type BusinessUnitFields,
  type BusinessUnitRecord,
} from './business-units.repository.js';

const toDto = (record: BusinessUnitRecord): BusinessUnitDto => ({
  id: record.id,
  name: record.name,
  code: record.code,
  description: record.description,
  headMembershipId: record.headMembershipId,
  headName: record.head?.user.fullName ?? null,
  sensitivity: record.sensitivity,
  employeeCount: record.employeeCount,
  parentId: record.parentId,
  parentName: record.parent?.name ?? null,
  archived: record.archivedAt !== null,
  archivedAt: record.archivedAt?.toISOString() ?? null,
  version: record.version,
});

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Business unit not found.');
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This business unit was changed by someone else. Reload and try again.',
  );
const nameTaken = () =>
  new AppException(
    ErrorCode.BusinessUnitNameTaken,
    HttpStatus.CONFLICT,
    'Another active business unit already has this name.',
  );
const codeTaken = () =>
  new AppException(
    ErrorCode.BusinessUnitCodeTaken,
    HttpStatus.CONFLICT,
    'Another business unit (possibly an archived one) already uses this code.',
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );

/**
 * Business units: a flat-or-nested list of the organisation's departments, subsidiaries or sites. Units
 * are archived, never deleted, because later records will point at them. Codes are unique per organisation
 * (archived units keep theirs); names are unique among ACTIVE units. Both are also enforced by unique
 * indexes, so two concurrent requests cannot both win. A unit's head is an ACTIVE member (not free text);
 * its parent is an active unit of the same organisation, never itself or one of its own descendants.
 */
@Injectable()
export class BusinessUnitsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly units: BusinessUnitsRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(query: BusinessUnitListQueryDto): Promise<BusinessUnitPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.units.list(tx, {
        limit,
        includeArchived: query.includeArchived === true,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
      }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async create(dto: CreateBusinessUnitDto): Promise<BusinessUnitDto> {
    try {
      return await this.uow.run(async (tx) => {
        const fields: BusinessUnitFields = {
          name: dto.name,
          code: dto.code ?? null,
          description: dto.description ?? null,
          headMembershipId: dto.headMembershipId ?? null,
          sensitivity: dto.sensitivity ?? null,
          employeeCount: dto.employeeCount ?? null,
          parentId: dto.parentId ?? null,
        };
        await this.assertFree(tx, fields.name, fields.code);
        await this.assertRelations(tx, fields.headMembershipId, fields.parentId);
        const created = await this.units.create(tx, fields);
        await this.audit.record(tx, {
          action: 'business_unit.created',
          entityType: 'business_unit',
          entityId: created.id,
          entityLabel: created.name,
          changes: { code: created.code, sensitivity: created.sensitivity },
        });
        return toDto(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(); // a concurrent request won the race
      throw error;
    }
  }

  async update(id: string, dto: UpdateBusinessUnitDto): Promise<BusinessUnitDto> {
    try {
      return await this.uow.run(async (tx) => {
        const current = await this.units.findById(tx, id);
        if (!current) throw notFound();
        if (current.version !== dto.version) throw versionConflict();
        if (current.archivedAt) {
          throw new AppException(
            ErrorCode.Conflict,
            HttpStatus.CONFLICT,
            'An archived business unit cannot be edited. Restore it first.',
          );
        }

        const changes: Partial<BusinessUnitFields> = {};
        const audited: Record<string, unknown> = {};
        const take = <K extends keyof BusinessUnitFields>(key: K, personal = false) => {
          const next = dto[key as keyof UpdateBusinessUnitDto] as BusinessUnitFields[K] | undefined;
          if (next === undefined || next === current[key]) return;
          changes[key] = next;
          audited[key] = personal ? 'changed' : { from: current[key], to: next };
        };
        take('name');
        take('code');
        take('description', true);
        take('headMembershipId', true);
        take('sensitivity');
        take('employeeCount');
        take('parentId');
        if (Object.keys(changes).length === 0) return toDto(current);

        await this.assertFree(tx, changes.name, changes.code ?? null, id);
        await this.assertRelations(
          tx,
          changes.headMembershipId ?? null,
          changes.parentId ?? null,
          id,
        );
        if (!(await this.units.update(tx, id, dto.version, changes))) throw versionConflict();
        await this.audit.record(tx, {
          action: 'business_unit.updated',
          entityType: 'business_unit',
          entityId: id,
          entityLabel: changes.name ?? current.name,
          changes: audited,
        });
        const fresh = await this.units.findById(tx, id); // the head and parent names may have changed
        return toDto(fresh ?? { ...current, ...changes, version: current.version + 1 });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  archive(id: string, dto: BusinessUnitVersionDto): Promise<BusinessUnitDto> {
    return this.uow.run(async (tx) => {
      const current = await this.units.findById(tx, id);
      if (!current) throw notFound();
      if (current.archivedAt) return toDto(current); // already archived: idempotent
      if (current.version !== dto.version) throw versionConflict();
      if ((await this.units.countActiveChildren(tx, id)) > 0) {
        throw new AppException(
          ErrorCode.BusinessUnitHasChildren,
          HttpStatus.CONFLICT,
          'This business unit has active units under it. Archive or move those first.',
        );
      }
      const archivedAt = this.clock.now();
      if (!(await this.units.update(tx, id, dto.version, { archivedAt }))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'business_unit.archived',
        entityType: 'business_unit',
        entityId: id,
        entityLabel: current.name,
      });
      return toDto({ ...current, archivedAt, version: current.version + 1 });
    });
  }

  async unarchive(id: string, dto: BusinessUnitVersionDto): Promise<BusinessUnitDto> {
    try {
      return await this.uow.run(async (tx) => {
        const current = await this.units.findById(tx, id);
        if (!current) throw notFound();
        if (!current.archivedAt) return toDto(current);
        if (current.version !== dto.version) throw versionConflict();
        // another unit may have taken the name while this one was archived (its code stays reserved)
        await this.assertFree(tx, current.name, null, id);
        if (!(await this.units.update(tx, id, dto.version, { archivedAt: null }))) {
          throw versionConflict();
        }
        await this.audit.record(tx, {
          action: 'business_unit.unarchived',
          entityType: 'business_unit',
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

  /** The friendly pre-check (the unique indexes are the guarantee). */
  private async assertFree(
    tx: Tx,
    name: string | undefined,
    code: string | null,
    exceptId?: string,
  ): Promise<void> {
    if (name !== undefined && (await this.units.findActiveByName(tx, name, exceptId))) {
      throw nameTaken();
    }
    if (code && (await this.units.findByCode(tx, code, exceptId))) throw codeTaken();
  }

  /** The head must be an active member and the parent an active unit that is not the unit itself or one of its descendants. */
  private async assertRelations(
    tx: Tx,
    headMembershipId: string | null,
    parentId: string | null,
    selfId?: string,
  ): Promise<void> {
    if (headMembershipId && !(await this.units.isActiveMember(tx, headMembershipId))) {
      throw invalid(
        'headMembershipId',
        'notAnActiveMember',
        'The head must be an active member of this organisation.',
      );
    }
    if (!parentId) return;
    if (parentId === selfId) {
      throw invalid('parentId', 'parentIsSelf', 'A business unit cannot be its own parent.');
    }
    const parent = await this.units.findById(tx, parentId);
    if (!parent) {
      throw invalid(
        'parentId',
        'unknownParent',
        'The parent is not a business unit of this organisation.',
      );
    }
    if (parent.archivedAt) {
      throw invalid('parentId', 'parentArchived', 'The parent is archived. Choose an active unit.');
    }
    // walk up from the parent: reaching the unit itself would make a loop
    let ancestor: BusinessUnitRecord | null = parent;
    for (let depth = 0; ancestor && depth < 50; depth++) {
      if (selfId && ancestor.parentId === selfId) {
        throw invalid(
          'parentId',
          'parentCycle',
          'A unit cannot be placed under one of its own sub-units.',
        );
      }
      ancestor = ancestor.parentId ? await this.units.findById(tx, ancestor.parentId) : null;
    }
  }
}
