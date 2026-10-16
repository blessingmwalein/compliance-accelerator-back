import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage, type PageQueryDto } from '../common/pagination.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type {
  CreateRegulatorContactDto,
  RegulatorContactDto,
  RegulatorContactPageDto,
  UpdateRegulatorContactDto,
} from './settings.dto.js';
import {
  RegulatorContactsRepository,
  type RegulatorContactRecord,
} from './regulator-contacts.repository.js';

const toDto = (record: RegulatorContactRecord): RegulatorContactDto => ({ ...record });

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Regulator contact not found.');
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This contact was changed by someone else. Reload and try again.',
  );

const FIELDS = [
  'authorityName',
  'jurisdiction',
  'contactName',
  'email',
  'phone',
  'notes',
] as const satisfies ReadonlyArray<keyof Omit<RegulatorContactRecord, 'id' | 'version'>>;

/**
 * Regulators and supervisory authorities the organisation reports to. They are typed in by the
 * organisation: the platform never assumes a regulator. The audit trail records the authority name and
 * which fields changed, never the contact person's details.
 */
@Injectable()
export class RegulatorContactsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly contacts: RegulatorContactsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(query: PageQueryDto): Promise<RegulatorContactPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.contacts.list(tx, { limit, ...(query.after ? { after: query.after } : {}) }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  create(dto: CreateRegulatorContactDto): Promise<RegulatorContactDto> {
    return this.uow.run(async (tx) => {
      const created = await this.contacts.create(tx, {
        authorityName: dto.authorityName,
        jurisdiction: dto.jurisdiction ?? null,
        contactName: dto.contactName ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        notes: dto.notes ?? null,
      });
      await this.audit.record(tx, {
        action: 'regulator_contact.created',
        entityType: 'regulator_contact',
        entityId: created.id,
        entityLabel: created.authorityName,
      });
      return toDto(created);
    });
  }

  update(id: string, dto: UpdateRegulatorContactDto): Promise<RegulatorContactDto> {
    return this.uow.run(async (tx) => {
      const current = await this.contacts.findById(tx, id);
      if (!current) throw notFound();
      if (current.version !== dto.version) throw versionConflict();

      const changes: Partial<Record<(typeof FIELDS)[number], string | null>> = {};
      for (const field of FIELDS) {
        const next = dto[field];
        if (next !== undefined && next !== current[field]) changes[field] = next;
      }
      if (Object.keys(changes).length === 0) return toDto(current);

      if (!(await this.contacts.update(tx, id, dto.version, changes as never))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'regulator_contact.updated',
        entityType: 'regulator_contact',
        entityId: id,
        entityLabel: changes.authorityName ?? current.authorityName,
        changes: { fields: Object.keys(changes) },
      });
      return toDto({
        ...current,
        ...changes,
        version: current.version + 1,
      } as RegulatorContactRecord);
    });
  }

  remove(id: string): Promise<void> {
    return this.uow.run(async (tx) => {
      const current = await this.contacts.findById(tx, id);
      if (!current) throw notFound();
      await this.contacts.delete(tx, id);
      await this.audit.record(tx, {
        action: 'regulator_contact.deleted',
        entityType: 'regulator_contact',
        entityId: id,
        entityLabel: current.authorityName,
      });
    });
  }
}
