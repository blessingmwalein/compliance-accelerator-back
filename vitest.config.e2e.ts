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
  },
});
