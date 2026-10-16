import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { redactChanges } from '../audit/redact.js';
import { RequestContext } from '../tenancy/request-context.js';
import { SecurityEventsRepository } from './security-events.repository.js';
import type { SecurityEventType } from './security-event-types.js';

export interface SecurityEventInput {
  type: SecurityEventType;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  userId?: string;
  /** Keyed hash of the email address, for events about accounts that may not exist. */
  subjectHash?: string;
  ipHash?: string;
  /** Small, non-personal context. Secrets are redacted; do not pass addresses or tokens. */
  metadata?: Record<string, unknown>;
}

/**
 * Writes events with no organisation (login, registration, refresh reuse). Pass the caller's `tx`
 * to commit with the change it describes; without one the event is written on its own. Like the
 * audit trail it is append-only, and the request id comes from the request scope.
 */
@Injectable()
export class SecurityEventsService {
  constructor(
    private readonly repository: SecurityEventsRepository,
    private readonly requestContext: RequestContext,
  ) {}

  record(event: SecurityEventInput, tx?: Tx): Promise<void> {
    return this.repository.insert(
      {
        eventType: event.type,
        outcome: event.outcome ?? 'SUCCESS',
        userId: event.userId ?? null,
        subjectHash: event.subjectHash ?? null,
        ipHash: event.ipHash ?? null,
        requestId: this.requestContext.requestId ?? null,
        metadata: event.metadata ? redactChanges(event.metadata) : null,
      },
      tx,
    );
  }
}
