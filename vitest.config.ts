import { defineConfig } from 'vitest/config';

// Each package runs as its own Vitest project with its own vitest.config.ts
// (vitest.workspace.ts is no longer read by Vitest 5).
export default defineConfig({
  test: {
    projects: ['packages/*']
  }
});
