import { describe, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  UnsafeTestDatabaseError,
  type TestDatabaseEnv,
} from './test-database.js';

const good: TestDatabaseEnv = {
  TEST_DATABASE_URL:
    'postgresql://app:s3cret-pass@ep-cool-123-pooler.eu-central-1.aws.neon.tech/fca_test?sslmode=require',
  TEST_DIRECT_URL:
    'postgresql://owner:0wner-pass@ep-cool-123.eu-central-1.aws.neon.tech/fca_test?sslmode=require',
  ALLOW_DESTRUCTIVE_TESTS: 'true',
  DATABASE_URL:
    'postgresql://app:dev-pass@ep-dev-456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  DIRECT_URL:
    'postgresql://owner:dev-pass@ep-dev-456.eu-central-1.aws.neon.tech/neondb?sslmode=require',
};

const refusal = (env: TestDatabaseEnv): string => {
  try {
    assertSafeTestDatabase(env);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsafeTestDatabaseError);
    return (error as Error).message;
  }
  return 'ACCEPTED';
};

describe('assertSafeTestDatabase', () => {
  it('accepts a correctly configured test database', () => {
    expect(assertSafeTestDatabase(good)).toEqual({
      databaseUrl: good.TEST_DATABASE_URL,
      directUrl: good.TEST_DIRECT_URL,
      databaseName: 'fca_test',
    });
  });

  it('refuses when anything is missing, and never silently skips', () => {
    expect(refusal({ ...good, TEST_DATABASE_URL: undefined })).toContain(
      'TEST_DATABASE_URL is not set',
    );
    expect(refusal({ ...good, TEST_DIRECT_URL: '' })).toContain('TEST_DIRECT_URL is not set');
    expect(refusal({ ...good, ALLOW_DESTRUCTIVE_TESTS: undefined })).toContain(
      'ALLOW_DESTRUCTIVE_TESTS',
    );
    expect(refusal({ ...good, ALLOW_DESTRUCTIVE_TESTS: 'yes' })).toContain(
      'ALLOW_DESTRUCTIVE_TESTS',
    );
  });

  it('refuses a database whose name does not contain "test" (Neon default is neondb)', () => {
    const renamed = {
      ...good,
      TEST_DATABASE_URL: good.TEST_DATABASE_URL!.replace('fca_test', 'neondb'),
      TEST_DIRECT_URL: good.TEST_DIRECT_URL!.replace('fca_test', 'neondb'),
    };
    expect(refusal(renamed)).toContain('does not contain "test"');
  });

  it('refuses pooled and direct strings that name different databases or endpoints', () => {
    expect(
      refusal({
        ...good,
        TEST_DIRECT_URL: good.TEST_DIRECT_URL!.replace('fca_test', 'other_test'),
      }),
    ).toContain('different databases');
    expect(
      refusal({
        ...good,
        TEST_DIRECT_URL: good.TEST_DIRECT_URL!.replace('ep-cool-123', 'ep-other-999'),
      }),
    ).toContain('different Neon endpoints');
  });

  it('refuses when the test database is the development database, even if it is named "test"', () => {
    const same = {
      ...good,
      DATABASE_URL: good.TEST_DATABASE_URL,
      DIRECT_URL: good.TEST_DIRECT_URL,
    };
    expect(refusal(same)).toContain('points at the same database as TEST_DATABASE_URL');
  });

  it('refuses malformed or non-postgres URLs', () => {
    expect(refusal({ ...good, TEST_DATABASE_URL: 'not a url' })).toContain(
      'not a valid connection string',
    );
    expect(refusal({ ...good, TEST_DATABASE_URL: 'mysql://u:p@h/test' })).toContain(
      'postgresql://',
    );
  });

  it('never puts a password or a host into a refusal message', () => {
    const messages = [
      refusal({ ...good, ALLOW_DESTRUCTIVE_TESTS: undefined }),
      refusal({
        ...good,
        TEST_DATABASE_URL: good.TEST_DATABASE_URL!.replace('fca_test', 'neondb'),
      }),
      refusal({ ...good, DATABASE_URL: good.TEST_DATABASE_URL, DIRECT_URL: good.TEST_DIRECT_URL }),
      refusal({ ...good, TEST_DATABASE_URL: 'mysql://u:s3cret-pass@h/test' }),
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/s3cret-pass|0wner-pass|dev-pass|neon\.tech|ep-cool/);
    }
  });
});
