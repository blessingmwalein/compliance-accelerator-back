import 'reflect-metadata'; // class-transformer/class-validator decorators need it even outside Nest
import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
  Silent = 'silent',
}

/**
 * Reads the RAW value (`obj[key]`): with implicit conversion enabled, `value` would already be
 * `Boolean('false') === true` by the time a @Transform runs.
 */
const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }): unknown => {
  const raw = obj[key];
  return raw === 'true' || raw === true ? true : raw === 'false' || raw === false ? false : raw;
};

export enum DnsResultOrder {
  /** The order the resolver returned. */
  Verbatim = 'verbatim',
  /** IPv4 addresses first: avoids long stalls where IPv6 is not routed (default). */
  Ipv4First = 'ipv4first',
  Ipv6First = 'ipv6first',
}

export enum MailTransport {
  /** Writes .eml files to DEV_MAIL_DIR and logs the action link. Development and tests only: nothing is delivered. */
  File = 'file',
}

export enum JobsRunner {
  /** A poller inside the API process (always-on hosts, local development). */
  Inproc = 'inproc',
  /** Host cron calls POST /api/v1/internal/jobs/tick. */
  External = 'external',
}

/**
 * Environment variables read by the application. Keys listed here MUST also appear in
 * `.env.example` (enforced by `npm run check:docs`).
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3001;

  /** Comma-separated list of exact browser origins allowed by CORS (no wildcards). */
  @IsString()
  CORS_ORIGINS: string = 'http://localhost:5173';

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  /** Serve Swagger UI at /api/docs. Defaults to true outside production. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  SWAGGER_ENABLED?: boolean;

  /** Pooled Neon connection string used at runtime. Absent => readiness reports not_configured. */
  @IsOptional()
  @IsString()
  DATABASE_URL?: string;

  @IsInt()
  @Min(1)
  @Max(100)
  DATABASE_POOL_MAX: number = 10;

  /** Generous default: Neon compute may need a few seconds to wake from scale-to-zero. */
  @IsInt()
  @Min(1000)
  @Max(120000)
  DATABASE_CONNECT_TIMEOUT_MS: number = 10000;

  /** Which addresses to try first when a hostname has both IPv4 and IPv6 (see src/common/http/network.ts). */
  @IsEnum(DnsResultOrder)
  DNS_RESULT_ORDER: DnsResultOrder = DnsResultOrder.Ipv4First;

  /** Time each resolved address gets before the next is tried. Node's default (250 ms) is shorter than one round trip to a distant region. */
  @IsInt()
  @Min(10)
  @Max(30000)
  NET_ATTEMPT_TIMEOUT_MS: number = 2000;

  /** How long one unit-of-work transaction may run. Keep transactions short: the Neon pooler is PgBouncer. */
  @IsInt()
  @Min(1000)
  @Max(120000)
  DATABASE_TRANSACTION_TIMEOUT_MS: number = 10000;

  /**
   * When true any signed-in user may create an organisation and becomes its Owner (`POST /organisations`).
   * Default false: organisations are provisioned by a platform administrator (gate G0 decides which
   * model production uses; this switch lets development and demos use the self-serve one).
   */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  ORGANISATIONS_SELF_SERVE?: boolean;

  /** Signs access tokens and derives the keyed hash used for lockout counters. At least 32 characters; rotate to invalidate every session. */
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsInt()
  @Min(60)
  @Max(3600)
  JWT_ACCESS_TTL_SECONDS: number = 900;

  /** Absolute lifetime of a login (session); the refresh token is rotated on every use within it. */
  @IsInt()
  @Min(1)
  @Max(365)
  REFRESH_TOKEN_TTL_DAYS: number = 30;

  /**
   * A rotated refresh token presented again within this many seconds is treated as a concurrent
   * request (several tabs restoring after a browser restart), not theft: it gets a fresh pair and
   * the session survives. Later reuse revokes the whole session. 0 disables the grace.
   */
  @IsInt()
  @Min(0)
  @Max(60)
  REFRESH_REUSE_GRACE_SECONDS: number = 10;

  /** Origin of the web app: the base of every link in an email. */
  @IsUrl({ require_tld: false, require_protocol: true })
  APP_BASE_URL: string = 'http://localhost:5173';

  /** Only when the web app and the API share a registrable domain (docs: gate G0). */
  @IsOptional()
  @IsString()
  COOKIE_DOMAIN?: string;

  /** The refresh cookie's Secure attribute. Defaults to true in production, false otherwise. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  COOKIE_SECURE?: boolean;

  /** Number of reverse-proxy hops to trust for the client IP (0 = none). Wrong values make IP-based limits spoofable. */
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY: number = 0;

  /** Coarse per-IP request limit per minute. Login/register routes have their own stricter limit. */
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 120;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  THROTTLE_ENABLED?: boolean;

  /** argon2id memory cost in KiB (OWASP minimum: 19456 with time cost 2). */
  @IsInt()
  @Min(8192)
  ARGON2_MEMORY_KIB: number = 19456;

  @IsInt()
  @Min(2)
  @Max(10)
  ARGON2_TIME_COST: number = 2;

  @IsEnum(MailTransport)
  MAIL_TRANSPORT: MailTransport = MailTransport.File;

  @IsString()
  @MaxLength(200)
  MAIL_FROM: string = 'Fernando Compliance Accelerator <no-reply@fca.localhost>';

  /** Where uploaded files (the company logo, later evidence) are stored by the local driver (git-ignored). Development and tests only: production uses object storage (gate G0). */
  @IsString()
  STORAGE_LOCAL_DIR: string = '.local-storage';

  /** Where the file transport writes .eml files (git-ignored). */
  @IsString()
  DEV_MAIL_DIR: string = '.dev-mail';

  /** inproc = poller in this process (default in development); external = host cron calls the tick endpoint (default elsewhere). */
  @IsOptional()
  @IsEnum(JobsRunner)
  JOBS_RUNNER?: JobsRunner;

  /** HMAC secret for POST /api/v1/internal/jobs/tick. Absent = the endpoint is disabled (404). At least 32 characters. */
  @IsOptional()
  @IsString()
  @MinLength(32)
  JOBS_TICK_SECRET?: string;

  @IsInt()
  @Min(500)
  JOBS_POLL_INTERVAL_MS: number = 5000;

  /** Jobs claimed per run (bounded so a tick never outlives a serverless time limit). */
  @IsInt()
  @Min(1)
  @Max(100)
  JOBS_BATCH_SIZE: number = 10;

  @IsInt()
  @Min(10)
  @Max(3600)
  JOBS_LEASE_SECONDS: number = 60;
}

/** Keys that MUST be supplied explicitly (no defaults) when NODE_ENV=production. */
const REQUIRED_IN_PRODUCTION: readonly (keyof EnvironmentVariables)[] = [
  'CORS_ORIGINS',
  'DATABASE_URL',
  'APP_BASE_URL',
];

/** Treat empty strings (e.g. `DATABASE_URL=` in a .env file) as "not set". */
function dropEmpty(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== ''));
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const input = dropEmpty(config);
  const validated = plainToInstance(EnvironmentVariables, input, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false, whitelist: false });
  const problems = errors.flatMap((error) =>
    Object.values(error.constraints ?? {}).map((message) => message),
  );

  if (validated.NODE_ENV === NodeEnv.Production) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (input[key] === undefined) {
        problems.push(`${key} must be set explicitly when NODE_ENV=production`);
      }
    }
  }

  // Validates every origin eagerly so a typo fails at boot rather than at the first request.
  try {
    parseCorsOrigins(validated.CORS_ORIGINS);
  } catch (error) {
    problems.push((error as Error).message);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  }

  const production = validated.NODE_ENV === NodeEnv.Production;
  validated.SWAGGER_ENABLED ??= !production;
  validated.COOKIE_SECURE ??= production;
  validated.THROTTLE_ENABLED ??= true;
  validated.ORGANISATIONS_SELF_SERVE ??= false;
  validated.JOBS_RUNNER ??=
    validated.NODE_ENV === NodeEnv.Development ? JobsRunner.Inproc : JobsRunner.External;
  return validated;
}

/**
 * Parses CORS_ORIGINS into exact origins. Wildcards are rejected because the API uses
 * credentialed requests (refresh-token cookie), which browsers refuse with `*` anyway.
 */
export function parseCorsOrigins(csv: string): string[] {
  const origins = csv
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one origin');
  }

  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS contains an invalid origin: "${origin}"`);
    }
    const isBareOrigin =
      url.origin === origin && (url.protocol === 'http:' || url.protocol === 'https:');
    if (!isBareOrigin) {
      throw new Error(
        `CORS_ORIGINS entries must be bare origins like https://app.example.com (got "${origin}")`,
      );
    }
  }

  return origins;
}
