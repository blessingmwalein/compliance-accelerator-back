import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { isUniqueViolation } from '../common/errors/unique-violation.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { MAPPING_DISCLAIMER } from '../frameworks/framework-content.service.js';
import type {
  CreateMappingDto,
  LoadDefaultsResultDto,
  MappingListQueryDto,
  MappingMatrixDto,
  MappingMatrixQueryDto,
  MappingPageDto,
  MappingRequirementDto,
  MappingVersionDto,
  MatrixEntryDto,
  MatrixNoteDto,
  MatrixRowDto,
  OrganisationMappingDto,
  UpdateMappingDto,
} from './compliance-mappings.dto.js';
import {
  OrganisationMappingsRepository,
  type MappingFields,
  type MappingFilters,
  type MappingRecord,
  type RequirementInfo,
} from './compliance-mappings.repository.js';

const toRequirementDto = (info: RequirementInfo): MappingRequirementDto => ({
  id: info.id,
  ref: info.ref,
  title: info.title,
  kind: info.kind,
  versionId: info.versionId,
  versionLabel: info.versionLabel,
  frameworkId: info.frameworkId,
  frameworkCode: info.frameworkCode,
});

const toDto = (record: MappingRecord): OrganisationMappingDto => ({
  id: record.id,
  areaId: record.areaId,
  areaName: record.areaName,
  from: toRequirementDto(record.from),
  to: toRequirementDto(record.to),
  relationship: record.relationship,
  origin: record.origin,
  rationale: record.rationale,
  reference: record.reference,
  reviewStatus: record.reviewStatus,
  archived: record.archivedAt !== null,
  archivedAt: record.archivedAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  version: record.version,
});

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Mapping not found.');
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This mapping was changed by someone else. Reload and try again.',
  );
const alreadyExists = () =>
  new AppException(
    ErrorCode.MappingAlreadyExists,
    HttpStatus.CONFLICT,
    'These two requirements are already mapped. Edit that mapping instead.',
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );

const USABLE = new Set(['VERIFIED', 'PUBLISHED']);

/**
 * Compliance mappings: an organisation's own links between requirements of two DIFFERENT frameworks,
 * optionally filed under a governance area, plus Load Default Mappings, which copies the entries of a
 * VERIFIED default pack. The platform never invents a mapping: with no verified pack, loading defaults
 * answers 422 and writes nothing. Mappings are informative and never establish legal equivalence.
 */
@Injectable()
export class ComplianceMappingsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly mappings: OrganisationMappingsRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(query: MappingListQueryDto): Promise<MappingPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.mappings.list(tx, {
        limit,
        includeArchived: query.includeArchived === true,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.areaId ? { areaId: query.areaId } : {}),
        ...(query.frameworkId ? { frameworkId: query.frameworkId } : {}),
        ...(query.relationship ? { relationship: query.relationship } : {}),
        ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
      }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<OrganisationMappingDto> {
    const record = await this.uow.run((tx) => this.mappings.findById(tx, id));
    if (!record) throw notFound();
    return toDto(record);
  }

  /** The mapping table: a page of governance areas with every entry of their mappings (the client builds the columns). */
  async matrix(query: MappingMatrixQueryDto): Promise<MappingMatrixDto> {
    const limit = pageSizeOf(query);
    const filters: MappingFilters = {
      includeArchived: query.includeArchived === true,
      ...(query.relationship ? { relationship: query.relationship } : {}),
      ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
    };
    return this.uow.run(async (tx) => {
      const areaRows = await this.mappings.listAreasForMatrix(tx, {
        ...filters,
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
      });
      const page = toPage(areaRows, limit);
      // the mappings that are not filed under an area come first, on the first page only, and only when
      // the area search does not narrow the table
      const unfiled =
        !query.after && !query.q && (await this.mappings.hasUnfiledMappings(tx, filters));
      const records = await this.mappings.listForAreas(
        tx,
        [...(unfiled ? [null] : []), ...page.items.map((area) => area.id)],
        filters,
      );

      const byArea = new Map<string | null, MatrixEntryDto[]>();
      for (const record of records) {
        const entries = byArea.get(record.areaId) ?? [];
        entries.push(...entriesOf(record));
        byArea.set(record.areaId, entries);
      }
      // the row's own reference cells, grouped by area; the unfiled row has none, having no area
      const notesByArea = new Map<string, MatrixNoteDto[]>();
      for (const note of await this.mappings.listNotesForAreas(
        tx,
        page.items.map((area) => area.id),
      )) {
        const cells = notesByArea.get(note.areaId) ?? [];
        cells.push({
          frameworkId: note.frameworkId,
          frameworkCode: note.frameworkCode,
          note: note.note,
          updatedAt: note.updatedAt.toISOString(),
        });
        notesByArea.set(note.areaId, cells);
      }
      const rows: MatrixRowDto[] = [
        ...(unfiled
          ? [
              {
                areaId: null,
                areaName: null,
                areaDescription: null,
                areaCategory: null,
                areaControlObjective: null,
                areaArchived: false,
                entries: byArea.get(null) ?? [],
                notes: [],
              },
            ]
          : []),
        ...page.items.map((area) => ({
          areaId: area.id,
          areaName: area.name,
          areaDescription: area.description,
          areaCategory: area.category,
          areaControlObjective: area.controlObjective,
          areaArchived: area.archivedAt !== null,
          entries: byArea.get(area.id) ?? [],
          notes: notesByArea.get(area.id) ?? [],
        })),
      ];
      return { rows, nextCursor: page.nextCursor, disclaimer: MAPPING_DISCLAIMER };
    });
  }

  async create(dto: CreateMappingDto): Promise<OrganisationMappingDto> {
    try {
      return await this.uow.run(async (tx) => {
        const fields: MappingFields = {
          areaId: dto.areaId ?? null,
          fromRequirementId: dto.fromRequirementId,
          toRequirementId: dto.toRequirementId,
          relationship: dto.relationship,
          rationale: dto.rationale,
          reference: dto.reference ?? null,
          reviewStatus: dto.reviewStatus ?? 'DRAFT',
        };
        await this.assertArea(tx, fields.areaId);
        await this.assertRequirements(tx, fields.fromRequirementId, fields.toRequirementId);
        await this.assertPairFree(tx, fields.fromRequirementId, fields.toRequirementId);
        const created = await this.mappings.create(tx, fields);
        await this.audit.record(tx, {
          action: 'mapping.created',
          entityType: 'organisation_mapping',
          entityId: created.id,
          entityLabel: label(created),
          changes: {
            relationship: created.relationship,
            reviewStatus: created.reviewStatus,
            areaId: created.areaId,
          },
        });
        return toDto(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyExists(); // a concurrent request won the race
      throw error;
    }
  }

  async update(id: string, dto: UpdateMappingDto): Promise<OrganisationMappingDto> {
    try {
      return await this.uow.run(async (tx) => {
        const current = await this.mappings.findById(tx, id);
        if (!current) throw notFound();
        if (current.version !== dto.version) throw versionConflict();
        if (current.archivedAt) {
          throw new AppException(
            ErrorCode.Conflict,
            HttpStatus.CONFLICT,
            'An archived mapping cannot be edited. Restore it first.',
          );
        }
        if (current.origin === 'SEED') this.assertSeedFieldsUntouched(current, dto);

        const changes: Partial<MappingFields> = {};
        const audited: Record<string, unknown> = {};
        const take = <K extends keyof MappingFields>(
          key: K,
          next: MappingFields[K] | undefined,
        ) => {
          const before = currentValue(current, key);
          if (next === undefined || next === before) return;
          changes[key] = next;
          audited[key] = key === 'rationale' ? 'changed' : { from: before, to: next };
        };
        take('areaId', dto.areaId);
        take('fromRequirementId', dto.fromRequirementId);
        take('toRequirementId', dto.toRequirementId);
        take('relationship', dto.relationship);
        take('rationale', dto.rationale);
        take('reference', dto.reference);
        take('reviewStatus', dto.reviewStatus);
        if (Object.keys(changes).length === 0) return toDto(current);

        if (changes.areaId !== undefined) await this.assertArea(tx, changes.areaId);
        if (changes.fromRequirementId !== undefined || changes.toRequirementId !== undefined) {
          const from = changes.fromRequirementId ?? current.from.id;
          const to = changes.toRequirementId ?? current.to.id;
          await this.assertRequirements(tx, from, to);
          await this.assertPairFree(tx, from, to, id);
        }
        if (!(await this.mappings.update(tx, id, dto.version, changes))) throw versionConflict();
        const fresh = await this.mappings.findById(tx, id);
        if (!fresh) throw notFound();
        await this.audit.record(tx, {
          action: 'mapping.updated',
          entityType: 'organisation_mapping',
          entityId: id,
          entityLabel: label(fresh),
          changes: audited,
        });
        return toDto(fresh);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyExists();
      throw error;
    }
  }

  archive(id: string, dto: MappingVersionDto): Promise<OrganisationMappingDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mappings.findById(tx, id);
      if (!current) throw notFound();
      if (current.archivedAt) return toDto(current); // already archived: idempotent
      if (current.version !== dto.version) throw versionConflict();
      const archivedAt = this.clock.now();
      if (!(await this.mappings.update(tx, id, dto.version, { archivedAt }))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'mapping.archived',
        entityType: 'organisation_mapping',
        entityId: id,
        entityLabel: label(current),
      });
      return toDto({ ...current, archivedAt, version: current.version + 1 });
    });
  }

  async unarchive(id: string, dto: MappingVersionDto): Promise<OrganisationMappingDto> {
    try {
      return await this.uow.run(async (tx) => {
        const current = await this.mappings.findById(tx, id);
        if (!current) throw notFound();
        if (!current.archivedAt) return toDto(current);
        if (current.version !== dto.version) throw versionConflict();
        // the pair may have been mapped again while this one was archived
        await this.assertPairFree(tx, current.from.id, current.to.id, id);
        if (!(await this.mappings.update(tx, id, dto.version, { archivedAt: null }))) {
          throw versionConflict();
        }
        await this.audit.record(tx, {
          action: 'mapping.unarchived',
          entityType: 'organisation_mapping',
          entityId: id,
          entityLabel: label(current),
        });
        return toDto({ ...current, archivedAt: null, version: current.version + 1 });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyExists();
      throw error;
    }
  }

  /**
   * Copies the entries of the VERIFIED default packs that concern this organisation's applicable frameworks.
   * One transaction; idempotent (an entry copied before, even if archived since, is skipped); never touches
   * a user's mapping. With no verified pack it answers 422 and writes nothing.
   */
  loadDefaults(): Promise<LoadDefaultsResultDto> {
    return this.uow.run(async (tx) => {
      const applicable = await this.mappings.applicableFrameworks(tx);
      if (applicable.length === 0) {
        throw new AppException(
          ErrorCode.NoFrameworksSelected,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'Choose the frameworks that apply to your organisation in Company Settings first.',
        );
      }
      const candidates = await this.mappings.candidatePackEntries(
        tx,
        applicable.map((framework) => framework.id),
      );
      if (candidates.length === 0) {
        const withContent = await this.mappings.frameworksWithContent(
          tx,
          applicable.map((framework) => framework.id),
        );
        const missing = applicable
          .filter((framework) => !withContent.has(framework.id))
          .map((framework) => framework.code);
        throw new AppException(
          ErrorCode.SeedDataUnavailable,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'No verified default mappings exist for your applicable frameworks, so nothing was loaded and nothing was changed.' +
            (missing.length > 0
              ? ` There is no verified content yet for: ${missing.join(', ')}.`
              : ' Verified content is loaded, but no verified crosswalk between these frameworks has been supplied.') +
            ' You can add mappings by hand.',
        );
      }
      const copied = await this.mappings.copiedEntryIds(
        tx,
        candidates.map((entry) => entry.id),
      );
      const toInsert = candidates.filter((entry) => !copied.has(entry.id));
      const inserted = await this.mappings.createSeedMappings(tx, toInsert);
      const result: LoadDefaultsResultDto = {
        inserted,
        skipped: candidates.length - inserted,
        failed: [],
        frameworks: applicable.map((framework) => framework.code),
      };
      await this.audit.record(tx, {
        action: 'mapping.defaults_loaded',
        entityType: 'organisation_mapping',
        changes: {
          inserted: result.inserted,
          skipped: result.skipped,
          frameworks: result.frameworks,
        },
      });
      return result;
    });
  }

  // ---- checks

  /** A mapping may be filed under an ACTIVE area of this organisation (or none). */
  private async assertArea(tx: Tx, areaId: string | null): Promise<void> {
    if (!areaId) return;
    const area = await this.mappings.findArea(tx, areaId);
    if (!area) {
      throw invalid(
        'areaId',
        'unknownArea',
        'The governance area does not exist in this organisation.',
      );
    }
    if (area.archivedAt) {
      throw invalid(
        'areaId',
        'areaArchived',
        'The governance area is archived. Choose an active area.',
      );
    }
  }

  /** Both requirements exist, belong to a loaded and verified version, and are of DIFFERENT frameworks. */
  private async assertRequirements(tx: Tx, fromId: string, toId: string): Promise<void> {
    if (fromId === toId) {
      throw invalid('toRequirementId', 'sameRequirement', 'Choose two different requirements.');
    }
    const found = await this.mappings.findRequirements(tx, [fromId, toId]);
    const from = found.find((requirement) => requirement.id === fromId);
    const to = found.find((requirement) => requirement.id === toId);
    if (!from) {
      throw invalid(
        'fromRequirementId',
        'unknownRequirement',
        'The source requirement does not exist.',
      );
    }
    if (!to) {
      throw invalid(
        'toRequirementId',
        'unknownRequirement',
        'The target requirement does not exist.',
      );
    }
    if (!USABLE.has(from.versionStatus)) {
      throw invalid(
        'fromRequirementId',
        'requirementUnavailable',
        'The source requirement belongs to a framework version that is not verified.',
      );
    }
    if (!USABLE.has(to.versionStatus)) {
      throw invalid(
        'toRequirementId',
        'requirementUnavailable',
        'The target requirement belongs to a framework version that is not verified.',
      );
    }
    if (from.frameworkId === to.frameworkId) {
      throw invalid(
        'toRequirementId',
        'sameFramework',
        'A mapping links two different frameworks. Choose a requirement of another framework.',
      );
    }
  }

  private async assertPairFree(
    tx: Tx,
    fromId: string,
    toId: string,
    exceptId?: string,
  ): Promise<void> {
    if (await this.mappings.findActiveByPair(tx, fromId, toId, exceptId)) throw alreadyExists();
  }

  /** A mapping copied from a verified pack keeps its requirements, relationship, rationale and reference. */
  private assertSeedFieldsUntouched(current: MappingRecord, dto: UpdateMappingDto): void {
    const locked: [string, boolean][] = [
      [
        'fromRequirementId',
        dto.fromRequirementId !== undefined && dto.fromRequirementId !== current.from.id,
      ],
      [
        'toRequirementId',
        dto.toRequirementId !== undefined && dto.toRequirementId !== current.to.id,
      ],
      ['relationship', dto.relationship !== undefined && dto.relationship !== current.relationship],
      ['rationale', dto.rationale !== undefined && dto.rationale !== current.rationale],
      ['reference', dto.reference !== undefined && dto.reference !== current.reference],
    ];
    const first = locked.find(([, changed]) => changed);
    if (first) {
      throw invalid(
        first[0],
        'seededMappingLocked',
        'A mapping that came from the verified default pack keeps its requirements, relationship and rationale. Archive it and add your own mapping instead.',
      );
    }
  }
}

const label = (record: MappingRecord): string =>
  `${record.from.frameworkCode} ${record.from.ref} → ${record.to.frameworkCode} ${record.to.ref}`;

function currentValue<K extends keyof MappingFields>(
  record: MappingRecord,
  key: K,
): MappingFields[K] | null {
  const values: Record<keyof MappingFields, unknown> = {
    areaId: record.areaId,
    fromRequirementId: record.from.id,
    toRequirementId: record.to.id,
    relationship: record.relationship,
    rationale: record.rationale,
    reference: record.reference,
    reviewStatus: record.reviewStatus,
  };
  return values[key] as MappingFields[K] | null;
}

/** A mapping appears twice in the table: once in the column of each framework it touches. */
function entriesOf(record: MappingRecord): MatrixEntryDto[] {
  const common = {
    mappingId: record.id,
    relationship: record.relationship,
    reviewStatus: record.reviewStatus,
    origin: record.origin,
    archived: record.archivedAt !== null,
  };
  return [
    {
      ...common,
      frameworkId: record.from.frameworkId,
      frameworkCode: record.from.frameworkCode,
      requirementId: record.from.id,
      ref: record.from.ref,
      title: record.from.title,
      counterpartFrameworkCode: record.to.frameworkCode,
      counterpartRef: record.to.ref,
    },
    {
      ...common,
      frameworkId: record.to.frameworkId,
      frameworkCode: record.to.frameworkCode,
      requirementId: record.to.id,
      ref: record.to.ref,
      title: record.to.title,
      counterpartFrameworkCode: record.from.frameworkCode,
      counterpartRef: record.from.ref,
    },
  ];
}
