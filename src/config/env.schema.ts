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
 * Which `StorageProvider` answers `put`/`get`/`delete` (ADR-0007). The local driver writes under
 * `STORAGE_LOCAL_DIR`: a real folder on a real disk, so it is the only sensible choice for development and
 * tests, and a wrong one wherever the process may be replaced without warning. The S3 driver is pointed at
 * an endpoint by environment, so the same code serves Supabase Storage today and any other
 * S3-compatible store later without a second implementation to keep honest.
 */
export enum StorageDriver {
  Local = 'local',
  S3 = 's3',
}

/**
 * The ceiling a body-size limit may be set to: the multipart interceptor's own bound, which is what the
 * evidence pipeline was built to hold in memory. `EVIDENCE_MAX_BYTES` states the cap a deployment advertises;
 * it can lower it, never raise it past this.
 */
export const MAX_UPLOAD_CEILING_BYTES = 10 * 1024 * 1024;

/**
 * The default upload ceiling: under the 4.5 MB a serverless function forwards in either direction, so the same
 * build works on a host that has that limit and on one that does not.
 */
export const DEFAULT_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;

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

  /** local = the folder above (development and tests); s3 = an S3-compatible object store, which is what production needs. */
  @IsOptional()
  @IsEnum(StorageDriver)
  STORAGE_DRIVER?: StorageDriver;

  /** The S3-compatible endpoint, scheme and host only, e.g. `https://<project-ref>.storage.supabase.co`. Supabase Storage speaks the S3 protocol; so do R2, B2 and Wasabi. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  STORAGE_S3_ENDPOINT?: string;

  /** The bucket every key lives in. Buckets are created in the store's own console, never by this app. */
  @IsOptional()
  @IsString()
  @MaxLength(63)
  STORAGE_S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  STORAGE_S3_ACCESS_KEY_ID?: string;

  /** A secret: never logged, never returned, and only ever used to sign requests to `STORAGE_S3_ENDPOINT`. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  STORAGE_S3_SECRET_ACCESS_KEY?: string;

  /** S3-compatible hosts differ on this: Supabase addresses buckets as `<endpoint>/<bucket>/<key>`, not as a subdomain. */
  @IsOptional()
  @Transform(toBoolean, { toClassOnly: true })
  @IsBoolean()
  STORAGE_S3_FORCE_PATH_STYLE?: boolean;

  /** The region the signature is scoped to. On Supabase this is the project's own region, shown beside the S3 credentials. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  STORAGE_S3_REGION?: string;

  /**
   * The largest evidence file this deployment accepts, as the API states it and the client obeys it.
   * A function host caps the whole request body (Vercel: 4.5 MB) and refuses a larger one before any
   * application code runs, so a limit above what the host forwards would only ever surprise the uploader.
   */
  @IsInt()
  @Min(1024)
  @Max(MAX_UPLOAD_CEILING_BYTES)
  EVIDENCE_MAX_BYTES: number = DEFAULT_EVIDENCE_MAX_BYTES;

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

  validated.STORAGE_DRIVER ??=
    validated.NODE_ENV === NodeEnv.Production ? StorageDriver.S3 : StorageDriver.Local;
  const driver = validated.STORAGE_DRIVER;

  if (driver === StorageDriver.S3) {
    // Every value is required rather than guessed: an S3 request signed for the wrong region or aimed at a
    // host built from a default fails with a signature or DNS error that reads as a bug in the app.
    for (const key of [
      'STORAGE_S3_ENDPOINT',
      'STORAGE_S3_BUCKET',
      'STORAGE_S3_ACCESS_KEY_ID',
      'STORAGE_S3_SECRET_ACCESS_KEY',
      'STORAGE_S3_REGION',
    ] as const) {
      if (validated[key] === undefined) {
        problems.push(`${key} must be set when STORAGE_DRIVER=s3`);
      }
    }
    if (validated.STORAGE_S3_ENDPOINT !== undefined) {
      problems.push(...endpointProblems(validated.STORAGE_S3_ENDPOINT));
    }
  } else if (validated.NODE_ENV === NodeEnv.Production) {
    problems.push(
      'STORAGE_DRIVER=local in production would write uploaded files to a disk the host may discard; set STORAGE_DRIVER=s3 (ADR-0007)',
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  }

  const production = validated.NODE_ENV === NodeEnv.Production;
  validated.SWAGGER_ENABLED ??= !production;
  validated.COOKIE_SECURE ??= production;
  validated.THROTTLE_ENABLED ??= true;
  validated.ORGANISATIONS_SELF_SERVE ??= false;
  validated.STORAGE_S3_FORCE_PATH_STYLE ??= true;
  validated.JOBS_RUNNER ??=
    validated.NODE_ENV === NodeEnv.Development ? JobsRunner.Inproc : JobsRunner.External;
  return validated;
}

/**
 * Checks the object store's address. The bucket is appended to it by the client, so a path, a query or an
 * embedded credential in this value would silently change which bucket every key lands in — or leak a secret
 * into a log line. `http` is accepted only so a local MinIO can be exercised the same way as the real thing.
 */
export function endpointProblems(endpoint: string): string[] {
  const invalid = (reason: string): string[] => [
    `STORAGE_S3_ENDPOINT is not usable (${reason}): "${endpoint}"`,
  ];
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return invalid('not an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return invalid('scheme must be http or https');
  if (url.username !== '' || url.password !== '')
    return invalid('credentials belong in the keys, not the URL');
  if (url.search !== '' || url.hash !== '') return invalid('it must carry no query or fragment');
  const path = url.pathname.replace(/\/$/, '');
  if (path !== '') return invalid('it must be the host only, with no path before the bucket');
  return [];
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
