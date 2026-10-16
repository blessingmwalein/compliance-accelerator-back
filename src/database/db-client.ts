import type { PrismaClient } from '../generated/prisma/client.js';
import { assertTenantScoped } from './tenant-guard.js';

/**
 * Wraps a Prisma client with the tenant safety net (ADR-0004, layer 3): every operation on a tenant
 * model is checked by `assertTenantScoped` against the tenant of the current request scope. The
 * extension also applies inside interactive transactions (`$transaction` callbacks).
 */
export function createDbClient(client: PrismaClient, currentTenantId: () => string | undefined) {
  return client.$extends({
    name: 'tenant-safety-net',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          assertTenantScoped({ model, operation, args, tenantId: currentTenantId() });
          return query(args);
        },
      },
    },
  });
}

/** The client repositories use. Raw access to the plain client stays private to PrismaService. */
export type DbClient = ReturnType<typeof createDbClient>;

/** The client handed to a unit-of-work callback: same API, minus connection and transaction control. */
export type Tx = Omit<DbClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;
