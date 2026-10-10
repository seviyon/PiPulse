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
      exclude: [
        '**/*.d.ts',
        // Process entry points: their tests spawn the built file (a child process Vitest
        // cannot measure), and the e2e and packaging suites run them. Left out of the figure
        // on purpose; the logic they call is covered in its own modules.
        'packages/web/src/main.tsx',
        'packages/api/src/server.ts',
        'packages/api/src/hash-password.ts',
        'packages/api/src/notify-test.ts',
        'packages/collector/src/main.ts'
      ]
    }
  }
});
