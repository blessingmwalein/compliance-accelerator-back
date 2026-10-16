import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type {
  FrameworkReferenceDto,
  FrameworkReferenceGuideDto,
  FrameworkVersionDto,
  RequirementListQueryDto,
  RequirementPageDto,
} from './framework-content.dto.js';
import {
  FrameworkContentRepository,
  type FrameworkVersionRecord,
  type RequirementRecord,
} from './framework-content.repository.js';
import { FrameworksRepository } from './frameworks.repository.js';

/** Every mapping surface carries this wording (compliance-frameworks skill). */
export const MAPPING_DISCLAIMER =
  'Cross-framework mappings are informative and do not establish legal equivalence. ' +
  'This platform supports a compliance programme; it does not provide legal advice.';

const toVersionDto = (record: FrameworkVersionRecord): FrameworkVersionDto => ({
  id: record.id,
  label: record.label,
  status: record.status,
  licenceClass: record.licenceClass,
  effectiveFrom: record.effectiveFrom?.toISOString().slice(0, 10) ?? null,
  sourceUrl: record.sourceUrl,
  citation: record.citation,
  retrievedAt: record.retrievedAt.toISOString(),
  verifiedBy: record.verifiedBy,
  verifiedAt: record.verifiedAt?.toISOString() ?? null,
  sourceHash: record.sourceHash,
  contentHash: record.contentHash,
  requirementCount: record.requirementCount,
  mappingEntryCount: record.mappingEntryCount,
});

const toRequirementDto = (record: RequirementRecord) => ({
  id: record.id,
  versionId: record.frameworkVersionId,
  parentId: record.parentId,
  ref: record.ref,
  kind: record.kind,
  title: record.title,
  description: record.description,
  textSource: record.textSource,
});

/** What framework content is loaded, with its provenance, and the requirement trees (global reference data). */
@Injectable()
export class FrameworkContentService {
  constructor(
    private readonly frameworks: FrameworksRepository,
    private readonly content: FrameworkContentRepository,
  ) {}

  /** The reference guide: every catalogue framework with its loaded versions, or "no verified content yet". */
  async referenceGuide(): Promise<FrameworkReferenceGuideDto> {
    const [catalogue, versions] = await Promise.all([
      this.frameworks.listActive(),
      this.content.listUsableVersions(),
    ]);
    const items: FrameworkReferenceDto[] = catalogue.map((framework) => {
      const own = versions
        .filter((version) => version.frameworkId === framework.id)
        .map(toVersionDto);
      return { ...framework, currentVersion: own[0] ?? null, versions: own };
    });
    return { items, disclaimer: MAPPING_DISCLAIMER };
  }

  async listRequirements(
    versionId: string,
    query: RequirementListQueryDto,
  ): Promise<RequirementPageDto> {
    if (!(await this.content.findUsableVersion(versionId))) {
      throw new AppException(
        ErrorCode.NotFound,
        HttpStatus.NOT_FOUND,
        'Framework version not found.',
      );
    }
    const limit = pageSizeOf(query);
    const rows = await this.content.listRequirements(versionId, {
      limit,
      ...(query.after ? { after: query.after } : {}),
      ...(query.q ? { q: query.q } : {}),
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    });
    const page = toPage(rows, limit);
    return { items: page.items.map(toRequirementDto), nextCursor: page.nextCursor };
  }
}
