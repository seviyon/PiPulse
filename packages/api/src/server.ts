import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openDb } from '@pipulse/storage';
import { builtinPlugins, startScheduler } from '@pipulse/collector';
import { buildServer, createLiveFeed } from './index.js';

/**
 * PiPulse server: one process that runs the collector scheduler and serves
 * the REST API plus the /api/live WebSocket. Each sample the scheduler
 * writes is pushed straight to connected clients. Shuts down cleanly on
 * SIGINT/SIGTERM (systemd and `docker stop` both send SIGTERM).
 */
const DB_PATH = process.env['PIPULSE_DB_PATH'] ?? 'pipulse.sqlite';
const HOST = process.env['PIPULSE_HOST'] ?? '0.0.0.0';
const PORT = Number(process.env['PIPULSE_PORT'] ?? 8888);
/** Comma-separated extra browser origins allowed on /api/live, e.g. behind a reverse proxy. */
const ALLOWED_ORIGINS = (process.env['PIPULSE_ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

/**
 * The built dashboard. Defaults to packages/web/dist beside this package's
 * dist/; if it hasn't been built, the server runs API-only.
 */
const WEB_DIR =
  process.env['PIPULSE_WEB_DIR'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

/** How long shutdown waits for in-flight sensor reads before giving up on them. */
const SHUTDOWN_TIMEOUT_MS = 5000;

const db = openDb(DB_PATH);
const live = createLiveFeed();
const app = buildServer(db, {
  live,
  allowedOrigins: ALLOWED_ORIGINS,
  ...(existsSync(WEB_DIR) ? { webRoot: WEB_DIR } : {}),
  plugins: builtinPlugins.map(({ id, label, unit, intervalMs }) => ({
    id,
    label,
    unit,
    intervalMs
  }))
});
const scheduler = startScheduler(db, builtinPlugins, {
  onSample: live.publish,
  onError: (plugin, error) => {
    console.error(`[pipulse] ${plugin.id} failed:`, error);
  }
});

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    const { port } = app.server.address() as AddressInfo;
    console.log(`[pipulse] listening on http://${HOST}:${port}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

let shuttingDown = false;

async function shutdown(): Promise<void> {
  // Our handlers replace Node's default terminate-on-signal, so a second
  // Ctrl-C/SIGTERM must still be able to kill a shutdown that is stuck.
  if (shuttingDown) {
    console.error('[pipulse] second signal received, exiting immediately');
    process.exit(1);
  }
  shuttingDown = true;
  const [, drained] = await Promise.all([app.close(), scheduler.stop(SHUTDOWN_TIMEOUT_MS)]);
  db.close();
  if (!drained) {
    console.error(
      `[pipulse] collections still running after ${SHUTDOWN_TIMEOUT_MS} ms, exiting without them`
    );
    // A hung read may still hold the event loop open; don't wait on it.
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}
