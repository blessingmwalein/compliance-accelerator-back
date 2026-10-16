import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment every test runs with. Hermetic by construction: never inherit a developer's real
 * database, secrets, mail directory or job runner. The secrets below are public test values.
 */
export const testEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: '',
  JWT_ACCESS_SECRET: 'test-only-jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  JOBS_TICK_SECRET: 'test-only-tick-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  JOBS_RUNNER: 'external',
  THROTTLE_ENABLED: 'false',
  DEV_MAIL_DIR: join(tmpdir(), 'fca-backend-test-mail'),
  // cheap argon2 so suites that hash passwords stay fast; production minimums are validated separately
  ARGON2_MEMORY_KIB: '8192',
  ARGON2_TIME_COST: '2',
};
