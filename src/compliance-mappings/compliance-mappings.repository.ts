import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type {
  FrameworkVersionStatus,
  MappingRelationship,
  MappingReviewStatus,
} from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { RequestContext } from '../tenancy/request-context.js';

/** A requirement with the framework version and framework it belongs to. */
export interface RequirementInfo {
  id: string;
  ref: string;
  title: string;
  kind: string;
  versionId: string;
  versionLabel: string;
  versionStatus: FrameworkVersionStatus;
  frameworkId: string;
  frameworkCode: string;
}

export interface MappingRecord {
  id: string;
  areaId: string | null;
  areaName: string | null;
  from: RequirementInfo;
  to: RequirementInfo;
  relationship: MappingRelationship;
  origin: 'SEED' | 'USER';
  sourceEntryId: string | null;
  rationale: string | null;
  reference: string | null;
  reviewStatus: MappingReviewStatus;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** The writable fields of a USER mapping (a seeded one only changes `areaId` and `reviewStatus`). */
export interface MappingFields {
  areaId: string | null;
  fromRequirementId: string;
  toRequirementId: string;
  relationship: MappingRelationship;
  rationale: string;
  reference: string | null;
  reviewStatus: MappingReviewStatus;
}

export interface PackEntryCandidate {
  id: string;
  fromRequirementId: string;
  toRequirementId: string;
  relationship: MappingRelationship;
  citation: string;
}

export interface MatrixAreaRecord {
  id: string;
  name: string;
  description: string | null;
  archivedAt: Date | null;
}

export interface MappingFilters {
  relationship?: MappingRelationship;
  reviewStatus?: MappingReviewStatus;
  includeArchived: boolean;
}

const REQUIREMENT_SELECT = {
  id: true,
  ref: true,
  title: true,
  kind: true,
  frameworkVersion: {
    select: {
      id: true,
      label: true,
      status: true,
      framework: { select: { id: true, code: true } },
    },
  },
} as const;

const SELECT = {
  id: true,
  areaId: true,
  area: { select: { name: true } },
  fromRequirement: { select: REQUIREMENT_SELECT },
  toRequirement: { select: REQUIREMENT_SELECT },
  relationship: true,
  origin: true,
  sourceEntryId: true,
  rationale: true,
  reference: true,
  reviewStatus: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  version: true,
} as const;

type RequirementRow = {
  id: string;
  ref: string;
  title: string;
  kind: string;
  frameworkVersion: {
    id: string;
    label: string;
    status: FrameworkVersionStatus;
    framework: { id: string; code: string };
  };
};

const toRequirementInfo = (row: RequirementRow): RequirementInfo => ({
  id: row.id,
  ref: row.ref,
  title: row.title,
  kind: row.kind,
  versionId: row.frameworkVersion.id,
  versionLabel: row.frameworkVersion.label,
  versionStatus: row.frameworkVersion.status,
  frameworkId: row.frameworkVersion.framework.id,
  frameworkCode: row.frameworkVersion.framework.code,
});

type MappingRow = Omit<MappingRecord, 'areaName' | 'from' | 'to'> & {
  area: { name: string } | null;
  fromRequirement: RequirementRow;
  toRequirement: RequirementRow;
};

const toRecord = ({ area, fromRequirement, toRequirement, ...row }: MappingRow): MappingRecord => ({
  ...row,
  areaName: area?.name ?? null,
  from: toRequirementInfo(fromRequirement),
  to: toRequirementInfo(toRequirement),
});

/** The versions whose content may be mapped (a draft is never loaded, but is never trusted either). */
const USABLE: FrameworkVersionStatus[] = ['VERIFIED', 'PUBLISHED'];

/**
 * Compliance mappings and governance-area lookups of the CURRENT organisation, plus the READS of the
 * global framework content they point at (requirements, pack entries). See `MembershipsRepository` for the
 * conventions: every method takes the unit-of-work transaction.
 */
@Injectable()
export class OrganisationMappingsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  private where(
    filters: MappingFilters,
    extra: Prisma.OrganisationMappingWhereInput = {},
  ): Prisma.OrganisationMappingWhereInput {
    return {
      organisationId: this.organisationId,
      ...(filters.includeArchived ? {} : { archivedAt: null }),
      ...(filters.relationship ? { relationship: filters.relationship } : {}),
      ...(filters.reviewStatus ? { reviewStatus: filters.reviewStatus } : {}),
      ...extra,
    };
  }

  /** Oldest first (ids are UUIDv7); fetches one extra row to detect another page. */
  async list(
    tx: Tx,
    options: MappingFilters & {
      limit: number;
      after?: string;
      q?: string;
      areaId?: string;
      frameworkId?: string;
    },
  ): Promise<MappingRecord[]> {
    const text = options.q
      ? [
          { ref: { contains: options.q, mode: 'insensitive' as const } },
          { title: { contains: options.q, mode: 'insensitive' as const } },
        ]
      : null;
    const rows = await tx.organisationMapping.findMany({
      where: this.where(options, {
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.areaId ? { areaId: options.areaId } : {}),
        AND: [
          ...(options.frameworkId
            ? [
                {
                  OR: [
                    { fromRequirement: { frameworkVersion: { frameworkId: options.frameworkId } } },
                    { toRequirement: { frameworkVersion: { frameworkId: options.frameworkId } } },
                  ],
                },
              ]
            : []),
          ...(text
            ? [{ OR: [{ fromRequirement: { OR: text } }, { toRequirement: { OR: text } }] }]
            : []),
        ],
      }),
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  async findById(tx: Tx, id: string): Promise<MappingRecord | null> {
    const row = await tx.organisationMapping.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
    return row ? toRecord(row) : null;
  }

  /** An ACTIVE mapping of the same two requirements in either direction, optionally ignoring one id. */
  async findActiveByPair(
    tx: Tx,
    fromRequirementId: string,
    toRequirementId: string,
    exceptId?: string,
  ): Promise<MappingRecord | null> {
    const row = await tx.organisationMapping.findFirst({
      where: {
        organisationId: this.organisationId,
        archivedAt: null,
        OR: [
          { fromRequirementId, toRequirementId },
          { fromRequirementId: toRequirementId, toRequirementId: fromRequirementId },
        ],
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: SELECT,
    });
    return row ? toRecord(row) : null;
  }

  async create(tx: Tx, data: MappingFields): Promise<MappingRecord> {
    const row = await tx.organisationMapping.create({
      data: { ...data, origin: 'USER', organisationId: this.organisationId },
      select: SELECT,
    });
    return toRecord(row);
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<MappingFields> & { archivedAt?: Date | null },
  ): Promise<boolean> {
    const result = await tx.organisationMapping.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  // ---- governance areas (the picker validation)

  /** The area of this organisation with this id (any state), or null. */
  findArea(tx: Tx, id: string): Promise<{ id: string; archivedAt: Date | null } | null> {
    return tx.governanceArea.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true, archivedAt: true },
    });
  }

  // ---- the matrix

  /**
   * A page of areas for the matrix: every ACTIVE area, plus an archived one only while it still holds a mapping
   * that passes the filters (so archiving an area never makes its mappings disappear). When a relationship or
   * review-status filter is set, only areas with at least one matching mapping.
   */
  listAreasForMatrix(
    tx: Tx,
    options: MappingFilters & { limit: number; after?: string; q?: string },
  ): Promise<MatrixAreaRecord[]> {
    const filtered = Boolean(options.relationship ?? options.reviewStatus);
    return tx.governanceArea.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.q ? { name: { contains: options.q, mode: 'insensitive' as const } } : {}),
        AND: [
          ...(filtered ? [{ mappings: { some: this.where(options) } }] : []),
          { OR: [{ archivedAt: null }, { mappings: { some: this.where(options) } }] },
        ],
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: { id: true, name: true, description: true, archivedAt: true },
    });
  }

  /** Mappings of the given areas (`null` in the list = mappings with no area). */
  async listForAreas(
    tx: Tx,
    areaIds: (string | null)[],
    filters: MappingFilters,
  ): Promise<MappingRecord[]> {
    const ids = areaIds.filter((id): id is string => id !== null);
    const withoutArea = areaIds.includes(null);
    if (ids.length === 0 && !withoutArea) return [];
    const rows = await tx.organisationMapping.findMany({
      where: this.where(filters, {
        OR: [
          ...(ids.length > 0 ? [{ areaId: { in: ids } }] : []),
          ...(withoutArea ? [{ areaId: null }] : []),
        ],
      }),
      orderBy: { id: 'asc' },
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  async hasUnfiledMappings(tx: Tx, filters: MappingFilters): Promise<boolean> {
    const count = await tx.organisationMapping.count({
      where: this.where(filters, { areaId: null }),
    });
    return count > 0;
  }

  // ---- global framework content (read only)

  /** The requirements with these ids, with their framework version and framework. */
  async findRequirements(tx: Tx, ids: string[]): Promise<RequirementInfo[]> {
    const rows = await tx.requirement.findMany({
      where: { id: { in: ids } },
      select: REQUIREMENT_SELECT,
    });
    return rows.map(toRequirementInfo);
  }

  // ---- Load Default Mappings

  /** The frameworks this organisation declared applicable now (a removed one does not count). */
  async applicableFrameworks(tx: Tx): Promise<{ id: string; code: string }[]> {
    const rows = await tx.organisationFramework.findMany({
      where: { organisationId: this.organisationId, removedAt: null },
      select: { framework: { select: { id: true, code: true, sortOrder: true } } },
    });
    return rows
      .map((row) => row.framework)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(({ id, code }) => ({ id, code }));
  }

  /** Frameworks (of the given ids) that have at least one usable version loaded. */
  async frameworksWithContent(tx: Tx, frameworkIds: string[]): Promise<Set<string>> {
    const rows = await tx.frameworkVersion.findMany({
      where: { frameworkId: { in: frameworkIds }, status: { in: USABLE } },
      select: { frameworkId: true },
      distinct: ['frameworkId'],
    });
    return new Set(rows.map((row) => row.frameworkId));
  }

  /** Pack entries whose BOTH requirements belong to a usable version of an applicable framework. */
  candidatePackEntries(tx: Tx, frameworkIds: string[]): Promise<PackEntryCandidate[]> {
    const side = {
      frameworkVersion: { status: { in: USABLE }, frameworkId: { in: frameworkIds } },
    };
    return tx.mappingPackEntry.findMany({
      where: { fromRequirement: side, toRequirement: side },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        fromRequirementId: true,
        toRequirementId: true,
        relationship: true,
        citation: true,
      },
    });
  }

  /** Which of these pack entries this organisation already copied (in ANY state, archived included). */
  async copiedEntryIds(tx: Tx, entryIds: string[]): Promise<Set<string>> {
    const rows = await tx.organisationMapping.findMany({
      where: { organisationId: this.organisationId, sourceEntryId: { in: entryIds } },
      select: { sourceEntryId: true },
    });
    return new Set(rows.flatMap((row) => (row.sourceEntryId ? [row.sourceEntryId] : [])));
  }

  /**
   * Copies pack entries into the organisation as SEED mappings. `skipDuplicates` is `ON CONFLICT DO NOTHING`,
   * so a concurrent run, or an active mapping of the same pair, never fails or duplicates; returns how many
   * rows were really inserted.
   */
  async createSeedMappings(tx: Tx, entries: PackEntryCandidate[]): Promise<number> {
    if (entries.length === 0) return 0;
    const result = await tx.organisationMapping.createMany({
      data: entries.map((entry) => ({
        organisationId: this.organisationId,
        fromRequirementId: entry.fromRequirementId,
        toRequirementId: entry.toRequirementId,
        relationship: entry.relationship,
        origin: 'SEED' as const,
        sourceEntryId: entry.id,
        rationale: `From the verified default mapping pack: ${entry.citation}`.slice(0, 1000),
      })),
      skipDuplicates: true,
    });
    return result.count;
  }
}
