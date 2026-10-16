import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { createDbClient, type DbClient } from '../database/db-client.js';
import { RequestContext } from '../tenancy/request-context.js';

export type DatabaseStatus = 'up' | 'down' | 'not_configured';

/** Placeholder so the client can be constructed (and the app booted, e.g. to export OpenAPI) without a database. */
const UNCONFIGURED_URL = 'postgresql://not-configured:not-configured@127.0.0.1:1/not-configured';

/**
 * The only place that talks to PostgreSQL. Repositories (and nothing else) inject this service and
 * use `db`, the tenant-checked client; the plain Prisma client is private on purpose, so a query
 * cannot bypass the tenant safety net by accident. The client connects lazily, so constructing it
 * never opens a connection.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly client: PrismaClient;
  /** Tenant-checked client (ADR-0004). Interactive transactions go through `UnitOfWork`. */
  readonly db: DbClient;
  readonly isConfigured: boolean;
  private readonly connectTimeoutMs: number;

  constructor(config: ConfigService<EnvironmentVariables, true>, requestContext: RequestContext) {
    // ConfigService falls back to raw process.env, where an empty string (DATABASE_URL=) is 'set'.
    const databaseUrl = config.get('DATABASE_URL', { infer: true }) || undefined;
    const connectTimeoutMs = config.get('DATABASE_CONNECT_TIMEOUT_MS', { infer: true });
    this.client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: databaseUrl ?? UNCONFIGURED_URL,
        max: config.get('DATABASE_POOL_MAX', { infer: true }),
        connectionTimeoutMillis: connectTimeoutMs,
      }),
    });
    this.db = createDbClient(this.client, () => requestContext.organisationId);
    this.isConfigured = databaseUrl !== undefined;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  /** Cheap reachability probe (`SELECT 1`) bounded by the connect timeout. Never throws. */
  async ping(): Promise<DatabaseStatus> {
    if (!this.isConfigured) return 'not_configured';

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('database ping timed out')), this.connectTimeoutMs);
    });

    try {
      await Promise.race([this.client.$queryRaw`SELECT 1`, timeout]);
      return 'up';
    } catch (error) {
      // The message can contain host names; it never contains the connection string or password.
      this.logger.warn(`Database ping failed: ${(error as Error).message}`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
