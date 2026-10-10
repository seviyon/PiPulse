import { defineConfig } from 'vitest/config';

// Each package runs as its own Vitest project with its own vitest.config.ts
// (vitest.workspace.ts is no longer read by Vitest 5).
export default defineConfig({
  test: {
    projects: ['packages/*'],
    // Only used by `npm run test:coverage` (CI uploads coverage/lcov.info to Codecov).
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', 'packages/web/src/main.tsx']
    }
  }
});
