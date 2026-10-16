import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';

export interface SettingsRecord {
  id: string;
  name: string;
  timezone: string;
  displayName: string | null;
  legalName: string | null;
  registrationNumber: string | null;
  sector: string | null;
  country: string | null;
  address: string | null;
  dpoName: string | null;
  dpoEmail: string | null;
  dpoPhone: string | null;
  logoKey: string | null;
  logoContentType: string | null;
  logoSize: number | null;
  logoSha256: string | null;
  logoUpdatedAt: Date | null;
  version: number;
}

export type SettingsChanges = Partial<
  Pick<
    SettingsRecord,
    | 'name'
    | 'timezone'
    | 'displayName'
    | 'legalName'
    | 'registrationNumber'
    | 'sector'
    | 'country'
    | 'address'
    | 'dpoName'
    | 'dpoEmail'
    | 'dpoPhone'
  >
>;

const SELECT = {
  id: true,
  name: true,
  timezone: true,
  displayName: true,
  legalName: true,
  registrationNumber: true,
  sector: true,
  country: true,
  address: true,
  dpoName: true,
  dpoEmail: true,
  dpoPhone: true,
  logoKey: true,
  logoContentType: true,
  logoSize: true,
  logoSha256: true,
  logoUpdatedAt: true,
  version: true,
} as const;

/**
 * The company settings live on the organisation row (the tenant root: its own id IS the tenant id, so
 * the safety net does not cover it; row-level security does). Callers run inside the organisation's
 * unit of work.
 */
@Injectable()
export class SettingsRepository {
  get(tx: Tx, organisationId: string): Promise<SettingsRecord | null> {
    return tx.organisation.findUnique({ where: { id: organisationId }, select: SELECT });
  }

  /** Optimistic update: false when the row changed since `version` was read. */
  async update(
    tx: Tx,
    organisationId: string,
    version: number,
    changes: SettingsChanges,
  ): Promise<boolean> {
    const result = await tx.organisation.updateMany({
      where: { id: organisationId, version },
      data: { ...changes, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** The logo does NOT bump `version`: that guards the settings fields, and a logo change must not make an open settings form stale. */
  async setLogo(
    tx: Tx,
    organisationId: string,
    logo: { key: string; contentType: string; size: number; sha256: string },
  ): Promise<void> {
    await tx.organisation.updateMany({
      where: { id: organisationId },
      data: {
        logoKey: logo.key,
        logoContentType: logo.contentType,
        logoSize: logo.size,
        logoSha256: logo.sha256,
        logoUpdatedAt: new Date(),
      },
    });
  }

  async clearLogo(tx: Tx, organisationId: string): Promise<void> {
    await tx.organisation.updateMany({
      where: { id: organisationId },
      data: {
        logoKey: null,
        logoContentType: null,
        logoSize: null,
        logoSha256: null,
        logoUpdatedAt: null,
      },
    });
  }
}
