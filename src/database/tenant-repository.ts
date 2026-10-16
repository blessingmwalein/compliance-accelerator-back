import type { RequestContext } from '../tenancy/request-context.js';

/**
 * Base class of every repository for a tenant-owned table (ADR-0004, layer 2). The tenant is read
 * from the request scope and is never a method parameter, so a caller cannot pass or forge another
 * tenant's id, and a repository method called outside a verified tenant scope throws.
 *
 *   findById(id) -> this.db.thing.findFirst({ where: { id, organisationId: this.organisationId } })
 *
 * There are no bare-id methods: `findUnique({ where: { id } })` and friends are rejected by the
 * safety net (`tenant-guard.ts`) even if a repository forgets.
 */
export abstract class TenantRepository {
  protected constructor(private readonly requestContext: RequestContext) {}

  /** The verified tenant of the current request; throws `TenantContextMissingError` outside one. */
  protected get organisationId(): string {
    return this.requestContext.requireOrganisationId();
  }
}
