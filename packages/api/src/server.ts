import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import {
  openDb,
  policyOf,
  retentionSource,
  startHousekeeping,
  type RetentionSettings
} from '@pipulse/storage';
import { builtinPlugins, readDeviceInfo, startScheduler } from '@pipulse/collector';
import {
  createRuleSource,
  readRulesFile,
  startAlerts,
  type AlertEvent,
  type RuleSource
} from '@pipulse/alerts';
import { readAuthConfig, type AuthConfig } from './auth.js';
import {
  buildServer,
  createFeed,
  createLiveFeed,
  longestLookBack,
  rawRetentionProblem
} from './index.js';

const METRICS = builtinPlugins.map(({ id, intervalMs }) => ({ id, intervalMs }));

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

function fail(error: unknown): never {
  console.error(`[pipulse] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** Sign-in settings (PIPULSE_ADMIN_PASSWORD_HASH_FILE, PIPULSE_PROTECT_READS). */
function readAuth(): AuthConfig {
  try {
    return readAuthConfig(process.env);
  } catch (error) {
    fail(error);
  }
}
const AUTH = readAuth();
const PASSWORD_HASH = AUTH.passwordHash;
const PROTECT_READS = AUTH.protectReads;

const db = openDb(DB_PATH);

/**
 * Retention in force: PIPULSE_RETENTION_* over values saved from the
 * Settings page over defaults, re-read on every housekeeping run. Resolved
 * once here so a bad environment value stops startup.
 */
const getRetention = retentionSource(db, process.env, (message) =>
  console.warn(`[pipulse] ${message}`)
);
function readRetention(): RetentionSettings {
  try {
    return getRetention();
  } catch (error) {
    fail(error);
  }
}
const RETENTION = readRetention();

/**
 * Alert rules: built-ins, PIPULSE_ALERTS_FILE over them, and rules saved
 * from the browser over both, re-read on every check. A bad file stops
 * startup with one line; a bad saved rule is logged and skipped.
 */
function readRuleSource(): RuleSource {
  const path = process.env['PIPULSE_ALERTS_FILE'];
  try {
    return createRuleSource(db, {
      cores: cpus().length,
      metrics: METRICS,
      rawRetention: () => {
        const raw = getRetention().raw;
        return { ms: raw.ms, text: raw.text };
      },
      onProblem: (message) => console.warn(`[pipulse] ${message}`),
      ...(path ? { file: readRulesFile(path) } : {})
    });
  } catch (error) {
    fail(error);
  }
}
const RULES = readRuleSource();
// Only rules in force must fit the raw retention in force. The file and
// built-in rules in force are checked here; saved rules that don't fit are
// skipped instead (see createRuleSource), and a rule disabled from the
// browser never runs, so it isn't checked at all.
const BASE_LOOK_BACK = longestLookBack(
  RULES.read().rules.filter((rule) => rule.source !== 'saved')
);
const RAW_PROBLEM = rawRetentionProblem(RETENTION.raw, BASE_LOOK_BACK);
if (RAW_PROBLEM) fail(RAW_PROBLEM);
const rulesInForce = () => RULES.read().rules;

const live = createLiveFeed();
const alertFeed = createFeed<AlertEvent>();
// buildServer runs before the alert engine starts (below), but its recheck
// hook needs to reach the engine once it exists; held in a property assigned
// later instead of a reassigned `let`.
const engine: { alerts?: { check(): void; stop(): void } } = {};
const app = buildServer(db, {
  live,
  device: await readDeviceInfo(),
  allowedOrigins: ALLOWED_ORIGINS,
  ...(existsSync(WEB_DIR) ? { webRoot: WEB_DIR } : {}),
  plugins: builtinPlugins.map(({ id, label, unit, intervalMs }) => ({
    id,
    label,
    unit,
    intervalMs
  })),
  alertRules: { source: RULES, recheck: () => engine.alerts?.check() },
  alertFeed,
  auth: { protectReads: PROTECT_READS, ...(PASSWORD_HASH ? { passwordHash: PASSWORD_HASH } : {}) },
  settings: { getRetention, metrics: METRICS, rawAtLeast: () => longestLookBack(rulesInForce()) }
});
// Rolls raw samples up into 1m/1h/1d buckets and prunes past retention, every
// minute, re-reading saved retention each run; compacts the file after big deletes.
const housekeeping = startHousekeeping(db, {
  retention: () => policyOf(getRetention()),
  vacuum: {
    onVacuum: (result) => {
      console.log(
        result.ran
          ? `[pipulse] vacuum: ${(result.beforeBytes / 1e6).toFixed(1)} MB → ${(result.afterBytes / 1e6).toFixed(1)} MB in ${(result.ms / 1000).toFixed(1)} s`
          : `[pipulse] vacuum skipped: ${result.reason}`
      );
    }
  },
  onError: (error) => {
    console.error('[pipulse] housekeeping failed:', error);
  }
});
const scheduler = startScheduler(db, builtinPlugins, {
  onSample: live.publish,
  onError: (plugin, error) => {
    console.error(`[pipulse] ${plugin.id} failed:`, error);
  }
});
// Checks every alert rule now and then every 15 s; raises and clears go to /api/live.
engine.alerts = startAlerts(db, {
  rules: rulesInForce,
  metrics: METRICS,
  onChange: alertFeed.publish,
  onError: (error, rule) => {
    console.error(
      rule ? `[pipulse] alert rule ${rule.id} failed:` : '[pipulse] alert check failed:',
      error
    );
  }
});

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    const { port } = app.server.address() as AddressInfo;
    console.log(
      `[pipulse] listening on http://${HOST}:${port}` +
        (PASSWORD_HASH ? '' : ' (read-only: PIPULSE_ADMIN_PASSWORD_HASH_FILE not set)') +
        (PROTECT_READS ? ' (reads need sign-in)' : '')
    );
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
  housekeeping.stop();
  engine.alerts?.stop();
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
