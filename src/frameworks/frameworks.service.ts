import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { Clock } from '../common/clock.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type { FrameworkDto, OrganisationFrameworkDto } from './frameworks.dto.js';
import { FrameworksRepository, OrganisationFrameworksRepository } from './frameworks.repository.js';

/**
 * The framework catalogue and each organisation's applicable set. Removing a framework from the set keeps
 * its row (`removedAt`), so history is never deleted and adding it again restores it. Nothing here
 * says what a framework requires: legal content with provenance arrives in Phase 4.
 */
@Injectable()
export class FrameworksService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly catalogue: FrameworksRepository,
    private readonly selections: OrganisationFrameworksRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** The active catalogue (same for every organisation). */
  async listCatalogue(): Promise<FrameworkDto[]> {
    return this.catalogue.listActive();
  }

  list(): Promise<OrganisationFrameworkDto[]> {
    return this.uow.run((tx) => this.build(tx));
  }

  /** Replaces the applicable set with exactly `frameworkIds`. Every change is audited. */
  set(frameworkIds: readonly string[]): Promise<OrganisationFrameworkDto[]> {
    return this.uow.run(async (tx) => {
      const catalogue = await this.catalogue.listActive(tx);
      const known = new Set(catalogue.map((framework) => framework.id));
      const unknown = frameworkIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new AppException(
          ErrorCode.ValidationFailed,
          HttpStatus.BAD_REQUEST,
          'Request validation failed.',
          unknown.map(() => ({
            path: 'frameworkIds',
            code: 'unknownFramework',
            message: 'frameworkIds contains a framework that is not in the catalogue',
          })),
        );
      }

      const desired = new Set(frameworkIds);
      const rows = new Map((await this.selections.list(tx)).map((row) => [row.frameworkId, row]));
      const now = this.clock.now();

      for (const framework of catalogue) {
        const row = rows.get(framework.id);
        const active = row !== undefined && row.removedAt === null;
        if (desired.has(framework.id) && !active) {
          if (row) await this.selections.setRemoved(tx, row.id, row.version, null);
          else await this.selections.create(tx, framework.id);
          await this.audit.record(tx, {
            action: 'framework.added',
            entityType: 'organisation_framework',
            entityId: framework.id,
            entityLabel: framework.code,
          });
        } else if (!desired.has(framework.id) && active) {
          await this.selections.setRemoved(tx, row.id, row.version, now);
          await this.audit.record(tx, {
            action: 'framework.removed',
            entityType: 'organisation_framework',
            entityId: framework.id,
            entityLabel: framework.code,
          });
        }
      }
      return this.build(tx);
    });
  }

  private async build(tx: Tx): Promise<OrganisationFrameworkDto[]> {
    const catalogue = await this.catalogue.listActive(tx);
    const rows = new Map((await this.selections.list(tx)).map((row) => [row.frameworkId, row]));
    return catalogue.map((framework) => {
      const row = rows.get(framework.id);
      return {
        ...framework,
        applicable: row !== undefined && row.removedAt === null,
        addedAt: row?.addedAt.toISOString() ?? null,
        removedAt: row?.removedAt?.toISOString() ?? null,
      };
    });
  }
}
