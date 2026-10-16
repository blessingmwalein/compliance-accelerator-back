export interface TestDatabaseEnv {
  TEST_DATABASE_URL?: string;
  TEST_DIRECT_URL?: string;
  ALLOW_DESTRUCTIVE_TESTS?: string;
  /** The development database: integration tests must never point at it. */
  DATABASE_URL?: string;
  DIRECT_URL?: string;
}

export interface SafeTestDatabase {
  /** Pooled URL the application under test connects with. */
  databaseUrl: string;
  /** Direct URL for migrations and for resetting data as the owner role. */
  directUrl: string;
  /** The database name (never the credentials). */
  databaseName: string;
}

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(
      `Refusing to run integration tests: ${message}\n` +
        'Integration tests are DESTRUCTIVE. Set TEST_DATABASE_URL, TEST_DIRECT_URL and ' +
        'ALLOW_DESTRUCTIVE_TESTS=true in fca-backend/.env, pointing at a database whose name contains ' +
        '"test" on the Neon `test` branch (docs/neon-setup.md).',
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

interface ParsedUrl {
  host: string;
  databaseName: string;
}

/** Parses a connection string without ever putting its credentials into an error message. */
function parse(name: string, value: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeTestDatabaseError(`${name} is not a valid connection string`);
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new UnsafeTestDatabaseError(`${name} must be a postgresql:// URL`);
  }
  return { host: url.hostname, databaseName: decodeURIComponent(url.pathname.replace(/^\//, '')) };
}

/** Neon hosts differ only by the "-pooler" suffix between the pooled and the direct string of one endpoint. */
const endpointOf = (host: string) => host.replace('-pooler', '');

/**
 * The destructive-test guard (testing-and-quality skill). It throws, with a message that names
 * the problem but never prints a connection string, unless everything says "this is the test database".
 */
export function assertSafeTestDatabase(env: TestDatabaseEnv): SafeTestDatabase {
  const { TEST_DATABASE_URL: pooled, TEST_DIRECT_URL: direct } = env;
  if (!pooled) throw new UnsafeTestDatabaseError('TEST_DATABASE_URL is not set');
  if (!direct) throw new UnsafeTestDatabaseError('TEST_DIRECT_URL is not set');
  if (env.ALLOW_DESTRUCTIVE_TESTS !== 'true') {
    throw new UnsafeTestDatabaseError('ALLOW_DESTRUCTIVE_TESTS is not "true"');
  }

  const pooledUrl = parse('TEST_DATABASE_URL', pooled);
  const directUrl = parse('TEST_DIRECT_URL', direct);

  for (const [name, parsed] of [
    ['TEST_DATABASE_URL', pooledUrl],
    ['TEST_DIRECT_URL', directUrl],
  ] as const) {
    if (!/test/i.test(parsed.databaseName)) {
      throw new UnsafeTestDatabaseError(
        `the database name in ${name} ("${parsed.databaseName}") does not contain "test"`,
      );
    }
  }
  if (pooledUrl.databaseName !== directUrl.databaseName) {
    throw new UnsafeTestDatabaseError(
      'TEST_DATABASE_URL and TEST_DIRECT_URL name different databases',
    );
  }
  if (endpointOf(pooledUrl.host) !== endpointOf(directUrl.host)) {
    throw new UnsafeTestDatabaseError(
      'TEST_DATABASE_URL and TEST_DIRECT_URL point at different Neon endpoints',
    );
  }

  // The development database must never be the test database, even if its name also says "test".
  for (const [name, value] of [
    ['DATABASE_URL', env.DATABASE_URL],
    ['DIRECT_URL', env.DIRECT_URL],
  ] as const) {
    if (!value) continue;
    const other = parse(name, value);
    if (
      endpointOf(other.host) === endpointOf(pooledUrl.host) &&
      other.databaseName === pooledUrl.databaseName
    ) {
      throw new UnsafeTestDatabaseError(`${name} points at the same database as TEST_DATABASE_URL`);
    }
  }

  return { databaseUrl: pooled, directUrl: direct, databaseName: pooledUrl.databaseName };
}
