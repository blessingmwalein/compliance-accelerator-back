import { defineConfig } from 'vitest/config';
import { testEnv } from './vitest.shared.js';

// Unit tests: pure logic and Nest wiring without a database or network.
export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json (Vite 8 ships this option).
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Hermetic by construction: never inherit a developer's real database or log settings.
    env: testEnv,
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/generated/**', 'src/cli/**'] },
  },
});
