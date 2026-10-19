import { defineConfig } from 'vitest/config';
import { testEnv } from './vitest.shared.js';

// End-to-end tests over HTTP (supertest) without a database. Database-backed integration tests
// (Neon `test` branch) get their own config and `test:int` script in Phase 2a.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    env: testEnv,
    // Every file boots its own Nest application and two of them rebuild the ConfigModule with a
    // different environment; with five applications compiling at once that takes far longer than the
    // default 10 s on a busy machine. Same reason as the capped `maxWorkers` in the frontend config.
    hookTimeout: 180_000,
  },
});
