import type { ConfigService } from '@nestjs/config';
import { AuthSettings } from '../../src/auth/auth-settings.js';
import type { EnvironmentVariables } from '../../src/config/env.schema.js';

export const TEST_JWT_SECRET = 'unit-test-jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

const DEFAULTS: Partial<Record<keyof EnvironmentVariables, unknown>> = {
  JWT_ACCESS_SECRET: TEST_JWT_SECRET,
  JWT_ACCESS_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  REFRESH_REUSE_GRACE_SECONDS: 10,
  APP_BASE_URL: 'https://app.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  COOKIE_SECURE: true,
  COOKIE_DOMAIN: undefined,
  ARGON2_MEMORY_KIB: 8192,
  ARGON2_TIME_COST: 2,
};

/** AuthSettings built from a plain object instead of the environment. */
export function makeSettings(
  overrides: Partial<Record<keyof EnvironmentVariables, unknown>> = {},
): AuthSettings {
  const values = { ...DEFAULTS, ...overrides };
  const config = {
    get: (key: keyof EnvironmentVariables) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return new AuthSettings(config);
}
