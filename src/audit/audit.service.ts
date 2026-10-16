import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { AuditAction } from './audit-actions.js';
import { AuditRepository } from './audit.repository.js';
import { redactChanges } from './redact.js';

export interface AuditEventInput {
  action: AuditAction;
  entityType: string;
  entityId?: string;
  /** The name or code as it reads now, so the trail stays understandable after a rename. */
  entityLabel?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  /** Field-level before/after values of the change. Secrets are redacted; do not pass DSAR/breach free text. */
  changes?: Record<string, unknown>;
}

/**
 * Writes audit events INSIDE the caller's transaction and FAILS CLOSED: there is no try/catch, so
 * if the insert fails the whole operation rolls back. (The legacy app swallowed audit errors and
 * stamped events with the browser clock.) The time comes from the database, the actor and request
 * id from the request scope, and the organisation from the verified tenant: none can be forged.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly requestContext: RequestContext,
  ) {}

  async record(tx: Tx, event: AuditEventInput): Promise<void> {
    const actorUserId = this.requestContext.actorUserId;
    await this.repository.insert(tx, {
      actorType: actorUserId ? 'USER' : 'SYSTEM',
      actorUserId: actorUserId ?? null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      entityLabel: event.entityLabel ?? null,
      outcome: event.outcome ?? 'SUCCESS',
      requestId: this.requestContext.requestId ?? null,
      changes: event.changes ? redactChanges(event.changes) : null,
    });
  }
}
