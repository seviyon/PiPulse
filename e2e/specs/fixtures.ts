import { test as base, type Page } from '@playwright/test';
import {
  E2E_PASSWORD,
  startServer,
  type RunningServer,
  type ServerOptions
} from '../src/harness/launch.js';

export { expect } from '@playwright/test';
export { E2E_PASSWORD };

interface Fixtures {
  /** Set per file with `test.use({ serverOptions: { ... } })`. */
  serverOptions: ServerOptions;
  server: RunningServer;
}

export const test = base.extend<Fixtures>({
  serverOptions: [{}, { option: true }],

  // One real server per test: a fresh database, port and folder.
  server: async ({ serverOptions }, use, testInfo) => {
    const server = await startServer(serverOptions);
    try {
      await use(server);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server.log', { body: server.logs(), contentType: 'text/plain' });
      }
      await server.stop();
    }
  },

  baseURL: async ({ server }, use) => {
    await use(server.baseUrl);
  }
});

/**
 * Signs the page's context in through the API (its cookies are shared). For tests where
 * signing in is set-up, not the subject. No Origin header is sent: the server allows that
 * for non-browser clients.
 */
export async function signIn(page: Page): Promise<void> {
  const response = await page.request.post('/api/login', { data: { password: E2E_PASSWORD } });
  if (!response.ok()) throw new Error(`sign-in failed: HTTP ${response.status()}`);
}
