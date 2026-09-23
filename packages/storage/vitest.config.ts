import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Daily rollups follow the server's local timezone; pin one with DST so
    // day boundaries (including 23- and 25-hour days) are tested for real.
    env: { TZ: 'Europe/Madrid' }
  }
});
