import { Injectable } from '@nestjs/common';
import type { FrameworkVersionStatus, TextSource } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface FrameworkVersionRecord {
  id: string;
  frameworkId: string;
  label: string;
  status: FrameworkVersionStatus;
  licenceClass: 'PUBLIC_DOMAIN' | 'OPEN_REUSE' | 'LICENSED_TEXT' | 'USER_SUPPLIED';
  effectiveFrom: Date | null;
  sourceUrl: string;
  citation: string;
  retrievedAt: Date;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  sourceHash: string;
  contentHash: string;
  requirementCount: number;
  mappingEntryCount: number;
}

export interface RequirementRecord {
  id: string;
  frameworkVersionId: string;
  parentId: string | null;
  ref: string;
  kind: string;
  title: string;
  description: string | null;
  textSource: TextSource;
}

const REQUIREMENT_SELECT = {
  id: true,
  frameworkVersionId: true,
  parentId: true,
  ref: true,
  kind: true,
  title: true,
  description: true,
  textSource: true,
} as const;

/** Versions with a status that may be shown and mapped. A draft is never loaded, but never trust that alone. */
export const USABLE_STATUSES: FrameworkVersionStatus[] = ['VERIFIED', 'PUBLISHED'];

/** Framework versions and requirements: GLOBAL reference data (no tenant column), read-only for the runtime role. */
@Injectable()
export class FrameworkContentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Every loaded version that may be used (verified or published), newest first. */
  async listUsableVersions(): Promise<FrameworkVersionRecord[]> {
    const rows = await this.prisma.db.frameworkVersion.findMany({
      where: { status: { in: USABLE_STATUSES } },
      orderBy: [{ effectiveFrom: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      include: { _count: { select: { requirements: true } } },
    });
    if (rows.length === 0) return [];
    // pack entries per version: through the requirement the entry maps FROM
    const entries = await this.prisma.db.mappingPackEntry.findMany({
      where: { fromRequirement: { frameworkVersionId: { in: rows.map((row) => row.id) } } },
      select: { fromRequirement: { select: { frameworkVersionId: true } } },
    });
    const perVersion = new Map<string, number>();
    for (const entry of entries) {
      const id = entry.fromRequirement.frameworkVersionId;
      perVersion.set(id, (perVersion.get(id) ?? 0) + 1);
    }
    return rows.map(({ _count, ...row }) => ({
      ...row,
      requirementCount: _count.requirements,
      mappingEntryCount: perVersion.get(row.id) ?? 0,
    }));
  }

  /** A usable version by id, or null (an unknown id and a version that is not usable look the same). */
  findUsableVersion(id: string): Promise<{ id: string } | null> {
    return this.prisma.db.frameworkVersion.findFirst({
      where: { id, status: { in: USABLE_STATUSES } },
      select: { id: true },
    });
  }

  /** Requirements of one version in the pack's order (ids are UUIDv7 and the loader inserts in order). */
  listRequirements(
    versionId: string,
    options: { limit: number; after?: string; q?: string; parentId?: string; kind?: string },
  ): Promise<RequirementRecord[]> {
    return this.prisma.db.requirement.findMany({
      where: {
        frameworkVersionId: versionId,
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.parentId ? { parentId: options.parentId } : {}),
        ...(options.kind ? { kind: { equals: options.kind, mode: 'insensitive' as const } } : {}),
        ...(options.q
          ? {
              OR: [
                { ref: { contains: options.q, mode: 'insensitive' as const } },
                { title: { contains: options.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: REQUIREMENT_SELECT,
    });
  }
}
