import { openDb, policyOf, retentionSource, startHousekeeping } from '@pipulse/storage';
import { builtinPlugins, startScheduler } from './index.js';

/**
 * Collector daemon: opens the database, polls every built-in plugin on its
 * own interval, and shuts down cleanly on SIGINT/SIGTERM (systemd and
 * `docker stop` both send SIGTERM).
 */
const dbPath = process.env['PIPULSE_DB_PATH'] ?? 'pipulse.sqlite';

/** How long shutdown waits for in-flight sensor reads before giving up on them. */
const SHUTDOWN_TIMEOUT_MS = 5000;

const db = openDb(dbPath);
// Same precedence as the server: environment › saved in the Settings page › default.
const getRetention = retentionSource(db, process.env, (message) =>
  console.warn(`[collector] ${message}`)
);
try {
  getRetention();
} catch (error) {
  console.error(`[collector] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// Rolls raw samples up into 1m/1h/1d buckets and prunes past retention, every minute.
const housekeeping = startHousekeeping(db, {
  retention: () => policyOf(getRetention()),
  onError: (error) => {
    console.error('[collector] housekeeping failed:', error);
  }
});
const scheduler = startScheduler(db, builtinPlugins, {
  onError: (plugin, error) => {
    console.error(`[collector] ${plugin.id} failed:`, error);
  }
});
console.log(`[collector] polling ${builtinPlugins.length} plugins into ${dbPath}`);

let shuttingDown = false;

async function shutdown(): Promise<void> {
  // Our handlers replace Node's default terminate-on-signal, so a second
  // Ctrl-C/SIGTERM must still be able to kill a shutdown that is stuck.
  if (shuttingDown) {
    console.error('[collector] second signal received, exiting immediately');
    process.exit(1);
  }
  shuttingDown = true;
  housekeeping.stop();
  const drained = await scheduler.stop(SHUTDOWN_TIMEOUT_MS);
  db.close();
  if (!drained) {
    console.error(
      `[collector] collections still running after ${SHUTDOWN_TIMEOUT_MS} ms, exiting without them`
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
