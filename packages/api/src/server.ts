import { loadConfig, StartupError } from './config.js';
import { SHUTDOWN_TIMEOUT_MS, startServer, type RunningServer } from './runtime.js';

/**
 * PiPulse server: one process that runs the collector scheduler and serves the REST API plus the
 * /api/live WebSocket. Shuts down cleanly on SIGINT/SIGTERM (systemd and `docker stop` both send
 * SIGTERM). The settings are read by loadConfig and the wiring is startServer's; this file only
 * decides what the process prints and which code it exits with.
 */

/** Refusals print one `[pipulse]` line; anything else (a listen failure, a crash) prints whole. */
function fail(error: unknown): never {
  if (error instanceof StartupError) console.error(`[pipulse] ${error.message}`);
  else console.error(error);
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  // Our handlers replace Node's default terminate-on-signal, so a second
  // Ctrl-C/SIGTERM must still be able to kill a shutdown that is stuck.
  if (shuttingDown) {
    console.error('[pipulse] second signal received, exiting immediately');
    process.exit(1);
  }
  shuttingDown = true;
  const { drained } = await (await starting).stop();
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

// The signal handlers are installed before startup begins (startServer opens the database
// synchronously, so they must already be there), and shutdown() waits for the start: a
// SIGTERM from systemd or `docker stop` while the server is still opening its database or binding
// its port waits for the start to finish and then stops cleanly, instead of killing the process
// with Node's default handler (no drain, no db.close).
const starting: Promise<RunningServer> = (async () => {
  try {
    return await startServer(loadConfig(process.env));
  } catch (error) {
    return fail(error);
  }
})();
