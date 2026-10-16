import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { roleHas } from '../permissions/catalogue.js';
import { StorageProvider } from '../storage/storage-provider.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { OrganisationSettingsDto, UpdateSettingsDto } from './settings.dto.js';
import {
  SettingsRepository,
  type SettingsChanges,
  type SettingsRecord,
} from './settings.repository.js';

export const MAX_LOGO_BYTES = 512 * 1024;

/** Only raster formats: SVG can carry script, so it is refused. The type is decided from the BYTES, not the name or header. */
function sniffImage(data: Buffer): 'image/png' | 'image/jpeg' | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length > png.length && png.every((byte, index) => data[index] === byte))
    return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg';
  return null;
}

const FIELDS = [
  'name',
  'timezone',
  'displayName',
  'legalName',
  'registrationNumber',
  'sector',
  'country',
  'address',
  'dpoName',
  'dpoEmail',
  'dpoPhone',
] as const satisfies ReadonlyArray<keyof SettingsChanges>;

/** Personal data is never copied into the audit trail: only the fact that the field changed. */
const PERSONAL_FIELDS: ReadonlySet<string> = new Set([
  'address',
  'dpoName',
  'dpoEmail',
  'dpoPhone',
]);

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Organisation not found.');

export function toSettingsDto(record: SettingsRecord): OrganisationSettingsDto {
  return {
    id: record.id,
    name: record.name,
    timezone: record.timezone,
    displayName: record.displayName,
    legalName: record.legalName,
    registrationNumber: record.registrationNumber,
    sector: record.sector,
    country: record.country,
    address: record.address,
    dpoName: record.dpoName,
    dpoEmail: record.dpoEmail,
    dpoPhone: record.dpoPhone,
    hasLogo: record.logoKey !== null,
    logoUpdatedAt: record.logoUpdatedAt?.toISOString() ?? null,
    version: record.version,
  };
}

/**
 * Company Settings: company information, the DPO contact and the logo. The display name and the logo are
 * branding (Company Owner only); everything else needs `company.edit`. The logo is stored through the
 * storage provider and served only through an authorised endpoint.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditService,
    private readonly storage: StorageProvider,
    private readonly requestContext: RequestContext,
  ) {}

  async get(): Promise<OrganisationSettingsDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const record = await this.uow.run((tx) => this.settings.get(tx, organisationId));
    if (!record) throw notFound();
    return toSettingsDto(record);
  }

  async update(dto: UpdateSettingsDto): Promise<OrganisationSettingsDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    const role = this.requestContext.get().role;

    return this.uow.run(async (tx) => {
      const current = await this.settings.get(tx, organisationId);
      if (!current) throw notFound();
      if (current.version !== dto.version) {
        throw new AppException(
          ErrorCode.VersionConflict,
          HttpStatus.CONFLICT,
          'The settings were changed by someone else. Reload and try again.',
        );
      }

      const changes: Record<string, string | null> = {};
      const audited: Record<string, unknown> = {};
      for (const field of FIELDS) {
        const next = dto[field];
        if (next === undefined || next === current[field]) continue;
        changes[field] = next;
        audited[field] = PERSONAL_FIELDS.has(field)
          ? 'changed'
          : { from: current[field], to: next };
      }
      if (Object.keys(changes).length === 0) return toSettingsDto(current);

      if ('displayName' in changes && !(role && roleHas(role, 'company.branding'))) {
        throw new AppException(
          ErrorCode.Forbidden,
          HttpStatus.FORBIDDEN,
          'Only a Company Owner can change how the organisation is displayed.',
        );
      }

      if (
        !(await this.settings.update(tx, organisationId, dto.version, changes as SettingsChanges))
      ) {
        throw new AppException(
          ErrorCode.VersionConflict,
          HttpStatus.CONFLICT,
          'The settings were changed by someone else. Reload and try again.',
        );
      }
      await this.audit.record(tx, {
        action: 'settings.updated',
        entityType: 'organisation',
        entityId: organisationId,
        entityLabel: changes.name ?? current.name,
        changes: audited,
      });
      const fresh = await this.settings.get(tx, organisationId);
      return toSettingsDto(fresh ?? current);
    });
  }

  /** Stores a new logo (PNG or JPEG up to 512 KiB) and removes the previous file. */
  async uploadLogo(data: Buffer | undefined): Promise<OrganisationSettingsDto> {
    const organisationId = this.requestContext.requireOrganisationId();
    if (!data || data.length === 0) {
      throw new AppException(ErrorCode.BadRequest, HttpStatus.BAD_REQUEST, 'Choose an image file.');
    }
    if (data.length > MAX_LOGO_BYTES) {
      throw new AppException(
        ErrorCode.PayloadTooLarge,
        HttpStatus.PAYLOAD_TOO_LARGE,
        'The logo must be 512 KiB or smaller.',
      );
    }
    const contentType = sniffImage(data);
    if (!contentType) {
      throw new AppException(
        ErrorCode.UnsupportedMediaType,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'The logo must be a PNG or JPEG image.',
      );
    }

    const key = `org/${organisationId}/logo/${randomUUID()}`;
    const stored = await this.storage.put(key, data);
    let previousKey: string | null;
    let result: SettingsRecord;
    try {
      ({ previousKey, result } = await this.uow.run(async (tx) => {
        const current = await this.settings.get(tx, organisationId);
        if (!current) throw notFound();
        await this.settings.setLogo(tx, organisationId, { key, contentType, ...stored });
        await this.audit.record(tx, {
          action: 'settings.logo_updated',
          entityType: 'organisation',
          entityId: organisationId,
          entityLabel: current.name,
          changes: { contentType, size: stored.size },
        });
        const fresh = await this.settings.get(tx, organisationId);
        return { previousKey: current.logoKey, result: fresh ?? current };
      }));
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined); // the database change failed: do not leave an orphan
      throw error;
    }
    if (previousKey) await this.storage.delete(previousKey).catch(() => undefined);
    return toSettingsDto(result);
  }

  /** The logo bytes for an authorised member. A missing logo (or a missing file) is a plain 404. */
  async downloadLogo(): Promise<{ data: Buffer; contentType: string; sha256: string }> {
    const organisationId = this.requestContext.requireOrganisationId();
    const record = await this.uow.run((tx) => this.settings.get(tx, organisationId));
    if (!record?.logoKey || !record.logoContentType || !record.logoSha256) {
      throw new AppException(
        ErrorCode.NotFound,
        HttpStatus.NOT_FOUND,
        'No logo has been uploaded.',
      );
    }
    const data = await this.storage.get(record.logoKey);
    if (!data) {
      throw new AppException(
        ErrorCode.NotFound,
        HttpStatus.NOT_FOUND,
        'No logo has been uploaded.',
      );
    }
    return { data, contentType: record.logoContentType, sha256: record.logoSha256 };
  }

  async removeLogo(): Promise<void> {
    const organisationId = this.requestContext.requireOrganisationId();
    const previousKey = await this.uow.run(async (tx) => {
      const current = await this.settings.get(tx, organisationId);
      if (!current) throw notFound();
      if (!current.logoKey) return null;
      await this.settings.clearLogo(tx, organisationId);
      await this.audit.record(tx, {
        action: 'settings.logo_removed',
        entityType: 'organisation',
        entityId: organisationId,
        entityLabel: current.name,
      });
      return current.logoKey;
    });
    if (previousKey) await this.storage.delete(previousKey).catch(() => undefined);
  }
}
