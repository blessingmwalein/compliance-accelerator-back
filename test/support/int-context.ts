import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication, Provider } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { isDatabaseUnavailable } from '../../src/common/errors/database-unavailable.js';
import { configureApp } from '../../src/common/http/configure-app.js';
import { UnitOfWork } from '../../src/database/unit-of-work.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { JobRunner } from '../../src/jobs/job-runner.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { RequestContext } from '../../src/tenancy/request-context.js';

/**
 * The owner-role client. Over a slow, distant link the direct connection occasionally drops while a
 * test seeds data; Neon is fine, the network is not. Transient CONNECTION errors are retried a few
 * times (and logged with their Prisma code, so a real pattern would show up), anything else throws at once.
 */
function createAdminClient(connectionString: string) {
  const base = new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 2, connectionTimeoutMillis: 60_000 }),
  });
  return base.$extends({
    name: 'retry-transient-connection-errors',
    query: {
      $allModels: {
        async $allOperations({ args, query, model, operation }) {
          for (let attempt = 1; ; attempt++) {
            try {
              return await query(args);
            } catch (error) {
              const { code, meta } = error as { code?: string; meta?: unknown };
              const transient =
                isDatabaseUnavailable(error) || (code === 'P2010' && isDatabaseUnavailable(meta));
              if (!transient || attempt >= 3) throw error;
              console.warn(
                `[int-context] retrying ${model}.${operation} after a transient connection error (code ${code ?? 'none'}, attempt ${attempt})`,
              );
              await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
            }
          }
        },
      },
    },
  });
}
type AdminClient = ReturnType<typeof createAdminClient>;

export interface IntContext {
  app: INestApplication;
  /** The application's own database access: runtime role, pooled URL, tenant safety net. */
  prisma: PrismaService;
  requestContext: RequestContext;
  uow: UnitOfWork;
  audit: AuditService;
  runner: JobRunner;
  /** Owner-role client for SEEDING and CHECKING only. It bypasses the safety net on purpose. */
  admin: AdminClient;
  /** supertest against the booted application (same HTTP configuration as production). */
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/**
 * Boots the real application module against the test database and opens an owner-role seeding
 * client. `providers` are added to the root testing module (for example a test-only job handler).
 */
export async function createIntContext(
  options: { providers?: Provider[] } = {},
): Promise<IntContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    providers: options.providers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const directUrl = process.env.TEST_DIRECT_URL;
  if (!directUrl)
    throw new Error('TEST_DIRECT_URL is not set (the global setup should have refused earlier)');
  const admin = createAdminClient(directUrl);

  return {
    app,
    prisma: app.get(PrismaService),
    requestContext: app.get(RequestContext),
    uow: app.get(UnitOfWork),
    audit: app.get(AuditService, { strict: false }),
    runner: app.get(JobRunner, { strict: false }),
    admin,
    http: () => request(app.getHttpServer()),
    async close() {
      await admin.$disconnect();
      await app.close();
    },
  };
}

/** Two organisations with one member each: the minimum for every isolation check. */
export async function seedTwoOrganisations(admin: AdminClient) {
  const tag = randomUUID().slice(0, 8);
  const make = async (label: string) => {
    const organisation = await admin.organisation.create({
      data: { name: `Org ${label} ${tag}`, timezone: 'Africa/Harare' },
    });
    const user = await admin.user.create({
      data: { email: `${label.toLowerCase()}-${tag}@example.test`, fullName: `User ${label}` },
    });
    const membership = await admin.membership.create({
      data: { organisationId: organisation.id, userId: user.id, role: 'COMPANY_OWNER' },
    });
    return { organisation, user, membership };
  };
  return { a: await make('A'), b: await make('B') };
}
