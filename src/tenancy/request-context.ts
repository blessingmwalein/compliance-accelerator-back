import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Role } from '../permissions/catalogue.js';

/** What the rest of the request needs to know about "who is doing this, for which tenant". */
export interface RequestScope {
  /** Lazy because the request id is assigned by the HTTP logger after this scope is created. */
  requestIdOf?: () => string | undefined;
  /** Set by the authentication guard (Phase 2b). Absent for system work such as jobs. */
  actorUserId?: string;
  /** The session of the access token (the `sid` claim), set by the authentication guard. */
  sessionId?: string;
  /** Set by the access guard once an ACTIVE membership is verified (never from client input). */
  organisationId?: string;
  /** The caller's membership in that organisation and its role, set together with `organisationId`. */
  membershipId?: string;
  role?: Role;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/** Turns a lazy thenable into a started promise (the call happens while the caller's scope is active). */
function startInsideScope<T>(value: T): T {
  return (isThenable(value) ? Promise.resolve(value) : value) as T;
}

/** Raised when tenant-scoped code runs without a verified tenant: always a programming error. */
export class TenantContextMissingError extends Error {
  constructor() {
    super('No organisation context: tenant-scoped code ran outside a verified tenant scope');
    this.name = 'TenantContextMissingError';
  }
}

/**
 * Request-scoped state in AsyncLocalStorage: the tenant, the actor and the request id travel with
 * the call chain, so a repository can never be handed (or forge) a tenant id as an argument.
 * Only guards and the unit of work write to it; repositories and services only read.
 */
@Injectable()
export class RequestContext {
  private readonly storage = new AsyncLocalStorage<RequestScope>();

  /**
   * Starts a scope. The object is stored as-is: guards enrich it later with `update`.
   *
   * Prisma queries are LAZY thenables: they only execute (and run the tenant safety net) when first
   * awaited. A query returned un-awaited from `fn` would therefore start outside this scope and
   * fail with TENANT_CONTEXT_MISSING. Any thenable `fn` returns is therefore started here, inside the scope.
   */
  run<T>(scope: RequestScope, fn: () => T): T {
    return this.storage.run(scope, () => startInsideScope(fn()));
  }

  /** Runs `fn` for another tenant while keeping the actor and request id (e.g. a freshly created organisation). */
  runInOrganisation<T>(organisationId: string, fn: () => T): T {
    return this.run({ ...this.get(), organisationId }, fn);
  }

  get(): Readonly<RequestScope> {
    return this.storage.getStore() ?? {};
  }

  /** Merges values into the active scope (guards use this). Throws outside a scope. */
  update(partial: Partial<Omit<RequestScope, 'requestIdOf'>>): void {
    const store = this.storage.getStore();
    if (!store) throw new Error('No active request scope to update');
    Object.assign(store, partial);
  }

  get organisationId(): string | undefined {
    return this.get().organisationId;
  }

  get actorUserId(): string | undefined {
    return this.get().actorUserId;
  }

  get requestId(): string | undefined {
    return this.get().requestIdOf?.();
  }

  requireOrganisationId(): string {
    const organisationId = this.organisationId;
    if (!organisationId) throw new TenantContextMissingError();
    return organisationId;
  }
}
