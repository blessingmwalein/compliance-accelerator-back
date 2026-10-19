import { JobsRunner, NodeEnv, parseCorsOrigins, validateEnv } from './env.schema.js';

const SECRET = 'a-test-secret-with-at-least-thirty-two-characters';
/** The smallest valid environment: the JWT secret has no default on purpose. */
const base = { JWT_ACCESS_SECRET: SECRET };
/**
 * The smallest valid production environment. The object store has to be named there, because production
 * defaults to `STORAGE_DRIVER=s3` — a host may discard the disk a file was written to.
 */
const production = {
  ...base,
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://app.example.com',
  APP_BASE_URL: 'https://app.example.com',
  DATABASE_URL: 'postgresql://user:pass@host/db',
  STORAGE_S3_ENDPOINT: 'https://projref.storage.supabase.co',
  STORAGE_S3_BUCKET: 'fca-files',
  STORAGE_S3_ACCESS_KEY_ID: 'key-id',
  STORAGE_S3_SECRET_ACCESS_KEY: 'secret-key',
  STORAGE_S3_REGION: 'us-east-1',
};

describe('validateEnv', () => {
  it('applies defaults for local development', () => {
    const env = validateEnv({ ...base });
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(3001);
    expect(env.CORS_ORIGINS).toBe('http://localhost:5173');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('coerces numeric strings and treats empty strings as unset', () => {
    const env = validateEnv({ ...base, PORT: '4000', DATABASE_URL: '', DATABASE_POOL_MAX: '5' });
    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_POOL_MAX).toBe(5);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('parses SWAGGER_ENABLED explicitly ("false" must not become true)', () => {
    expect(validateEnv({ ...base, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED).toBe(false);
    expect(validateEnv({ ...base, SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED).toBe(true);
  });

  it('disables Swagger by default in production', () => {
    expect(validateEnv(production).SWAGGER_ENABLED).toBe(false);
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => validateEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ ...base, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('requires explicit CORS_ORIGINS, DATABASE_URL and APP_BASE_URL in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /CORS_ORIGINS must be set explicitly[\s\S]*DATABASE_URL must be set explicitly[\s\S]*APP_BASE_URL must be set explicitly/,
    );
  });
});

describe('validateEnv: authentication, mail and jobs (Phase 2b)', () => {
  it('has no default for the JWT secret and refuses a short one', () => {
    expect(() => validateEnv({})).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => validateEnv({ JWT_ACCESS_SECRET: '' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => validateEnv({ JWT_ACCESS_SECRET: 'too-short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(validateEnv({ ...base }).JWT_ACCESS_SECRET).toBe(SECRET);
  });

  it('defaults to a 15 minute access token, a 30 day session and a 10 second refresh grace', () => {
    const env = validateEnv({ ...base });
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(env.REFRESH_REUSE_GRACE_SECONDS).toBe(10);
  });

  it('bounds the access token lifetime (a long-lived JWT defeats revocation)', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_TTL_SECONDS: '86400' })).toThrow(
      /JWT_ACCESS_TTL_SECONDS/,
    );
    expect(() => validateEnv({ ...base, JWT_ACCESS_TTL_SECONDS: '5' })).toThrow(
      /JWT_ACCESS_TTL_SECONDS/,
    );
  });

  it('makes the refresh cookie Secure by default only in production, and lets you override it', () => {
    expect(validateEnv({ ...base }).COOKIE_SECURE).toBe(false);
    expect(validateEnv(production).COOKIE_SECURE).toBe(true);
    expect(validateEnv({ ...production, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('runs the job poller in-process only in development by default', () => {
    expect(validateEnv({ ...base }).JOBS_RUNNER).toBe(JobsRunner.Inproc);
    expect(validateEnv({ ...base, NODE_ENV: 'test' }).JOBS_RUNNER).toBe(JobsRunner.External);
    expect(validateEnv({ ...base, JOBS_RUNNER: 'external' }).JOBS_RUNNER).toBe(JobsRunner.External);
    expect(() => validateEnv({ ...base, JOBS_RUNNER: 'magic' })).toThrow(/JOBS_RUNNER/);
  });

  it('leaves the tick endpoint disabled without a secret and requires a long one when set', () => {
    expect(validateEnv({ ...base }).JOBS_TICK_SECRET).toBeUndefined();
    expect(validateEnv({ ...base, JOBS_TICK_SECRET: '' }).JOBS_TICK_SECRET).toBeUndefined();
    expect(() => validateEnv({ ...base, JOBS_TICK_SECRET: 'short' })).toThrow(/JOBS_TICK_SECRET/);
    expect(validateEnv({ ...base, JOBS_TICK_SECRET: SECRET }).JOBS_TICK_SECRET).toBe(SECRET);
  });

  it('validates the app URL used in emails', () => {
    expect(validateEnv({ ...base }).APP_BASE_URL).toBe('http://localhost:5173');
    expect(() => validateEnv({ ...base, APP_BASE_URL: 'not a url' })).toThrow(/APP_BASE_URL/);
  });

  it('only knows the file mail transport until a provider is chosen (gate G0)', () => {
    expect(validateEnv({ ...base }).MAIL_TRANSPORT).toBe('file');
    expect(() => validateEnv({ ...base, MAIL_TRANSPORT: 'smtp' })).toThrow(/MAIL_TRANSPORT/);
  });

  it('enables rate limiting by default and keeps argon2 at the OWASP minimum', () => {
    const env = validateEnv({ ...base });
    expect(env.THROTTLE_ENABLED).toBe(true);
    expect(env.ARGON2_MEMORY_KIB).toBe(19456);
    expect(env.ARGON2_TIME_COST).toBe(2);
    expect(() => validateEnv({ ...base, ARGON2_MEMORY_KIB: '1024' })).toThrow(/ARGON2_MEMORY_KIB/);
  });
});

describe('validateEnv: network (connection reliability)', () => {
  it('prefers IPv4 and gives each address 2 s by default', () => {
    const env = validateEnv({ ...base });
    expect(env.DNS_RESULT_ORDER).toBe('ipv4first');
    expect(env.NET_ATTEMPT_TIMEOUT_MS).toBe(2000);
  });

  it('accepts the other orders and rejects nonsense', () => {
    expect(validateEnv({ ...base, DNS_RESULT_ORDER: 'verbatim' }).DNS_RESULT_ORDER).toBe(
      'verbatim',
    );
    expect(() => validateEnv({ ...base, DNS_RESULT_ORDER: 'ipv5' })).toThrow(/DNS_RESULT_ORDER/);
    expect(() => validateEnv({ ...base, NET_ATTEMPT_TIMEOUT_MS: '1' })).toThrow(
      /NET_ATTEMPT_TIMEOUT_MS/,
    );
  });
});

describe('parseCorsOrigins', () => {
  it('splits, trims and returns exact origins', () => {
    expect(parseCorsOrigins('http://localhost:5173, https://app.example.com')).toEqual([
      'http://localhost:5173',
      'https://app.example.com',
    ]);
  });

  it.each([
    '*',
    'https://app.example.com/',
    'https://app.example.com/path',
    'app.example.com',
    'ftp://x.test',
  ])('rejects %s', (origin) => {
    expect(() => parseCorsOrigins(origin)).toThrow(/CORS_ORIGINS/);
  });

  it('rejects an empty list', () => {
    expect(() => parseCorsOrigins(' , ')).toThrow(/at least one origin/);
  });
});
