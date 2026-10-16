import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';

export interface OrganisationRecord {
  id: string;
  name: string;
  timezone: string;
}

/**
 * The tenant ROOT table: an organisation's own id IS the tenant id, so it has no `organisation_id`
 * and is not covered by the tenant safety net. Callers run inside the (new) organisation's scope.
 */
@Injectable()
export class OrganisationsRepository {
  create(tx: Tx, data: OrganisationRecord): Promise<OrganisationRecord> {
    return tx.organisation.create({
      data,
      select: { id: true, name: true, timezone: true },
    });
  }

  findById(tx: Tx, id: string): Promise<OrganisationRecord | null> {
    return tx.organisation.findUnique({
      where: { id },
      select: { id: true, name: true, timezone: true },
    });
  }
}
