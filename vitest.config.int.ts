import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import { testEnv } from './vitest.shared.js';

// Integration tests against the Neon `test` branch (Phase 2a). They are DESTRUCTIVE: the global
// setup refuses to run unless TEST_DATABASE_URL / TEST_DIRECT_URL name a database containing
// "test" and ALLOW_DESTRUCTIVE_TESTS=true. A missing URL makes `npm run test:int` FAIL with a clear
// message; it never silently skips.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts'],
    // One database, so one test file at a time; each test creates its own organisations.
    fileParallelism: false,
    // A real network: Neon compute may need seconds to wake from scale-to-zero, a new connection took
    // 3 to 5 s and every query about 300 ms from a distant machine (us-east-2), and one test makes many
    // sequential queries. Generous limits, so a slow link never looks like a failing assertion.
    testTimeout: 180_000,
    hookTimeout: 300_000,
    globalSetup: ['./test/support/int-global-setup.ts'],
    env: {
      ...testEnv,
      // The application under test connects exactly like production: through the pooled URL.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      // Organisation creation by any signed-in user is on here so the specs can create organisations through the API.
      ORGANISATIONS_SELF_SERVE: 'true',
      DATABASE_CONNECT_TIMEOUT_MS: '60000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '60000',
    },
  },
});
