import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { cpus, hostname } from 'node:os';
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
import {
  parseNotifyConfig,
  readNotifyFile,
  startNotifications,
  type WebhookConfig
} from '@pipulse/notify';
import { readAuthConfig, type AuthConfig } from './auth.js';
import { CONTAINER_UNAVAILABLE, splitForContainer } from './container.js';
import { createHealth } from './health.js';
import { nodeSupport, readVersion } from './version.js';
import {
  buildServer,
  createFeed,
  createLiveFeed,
  longestLookBack,
  rawRetentionProblem
} from './index.js';

// In a container (the Docker image sets these) the firmware plugins can't run, and
// the host's OS name and Pi model are mounted under PIPULSE_HOST_ROOT.
const IN_CONTAINER = process.env['PIPULSE_IN_CONTAINER'] === 'true';
const HOST_ROOT = process.env['PIPULSE_HOST_ROOT'];
const { run: RUN_PLUGINS, unavailable: UNAVAILABLE } = splitForContainer(
  builtinPlugins,
  IN_CONTAINER
);

const METRICS = builtinPlugins.map(({ id, intervalMs }) => ({ id, intervalMs }));
// What the engine watches: only plugins that run here, so the '*' silence rule
// (not_collecting) never waits on a plugin a container can't schedule.
const RUN_METRICS = RUN_PLUGINS.map(({ id, intervalMs }) => ({ id, intervalMs }));

/**
 * PiPulse server: one process that runs the collector scheduler and serves
 * the REST API plus the /api/live WebSocket. Each sample the scheduler
 * writes is pushed straight to connected clients. Shuts down cleanly on
 * SIGINT/SIGTERM (systemd and `docker stop` both send SIGTERM).
 */
const DB_PATH = process.env['PIPULSE_DB_PATH'] ?? 'pipulse.sqlite';
const HOST = process.env['PIPULSE_HOST'] ?? '0.0.0.0';
const PORT = Number(process.env['PIPULSE_PORT'] ?? 8889);
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

// The app root is three levels above packages/api/dist/server.js; a release stamps version.json there.
const VERSION = readVersion(fileURLToPath(new URL('../../../', import.meta.url)));
const NODE = nodeSupport();

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

/** Webhooks from PIPULSE_NOTIFY_FILE, if set; a bad file stops startup with one line. */
function readWebhooks(): WebhookConfig[] {
  const path = process.env['PIPULSE_NOTIFY_FILE'];
  if (!path) return [];
  try {
    const file = readNotifyFile(path);
    if (file.worldReadable)
      console.warn('[pipulse] PIPULSE_NOTIFY_FILE is readable by other users; chmod 600 it');
    return parseNotifyConfig(file);
  } catch (error) {
    fail(error);
  }
}
// Queues a message per alert raise/clear for each webhook and delivers it
// in order, retrying for up to 6 h; survives restarts through the outbox.
const notifications = startNotifications(db, {
  webhooks: readWebhooks(),
  hostname: hostname(),
  metrics: builtinPlugins.map(({ id, label, unit }) => ({ id, label, unit })),
  log: (message) => console.warn(`[pipulse] ${message}`)
});

// Liveness for /api/health: the database answers and readings keep arriving.
const health = createHealth(db, { trackReadings: true });

const live = createLiveFeed();
const alertFeed = createFeed<AlertEvent>();
// buildServer runs before the alert engine starts (below), but its recheck
// hook needs to reach the engine once it exists; held in a property assigned
// later instead of a reassigned `let`.
const engine: { alerts?: { check(): void; stop(): void } } = {};
const app = buildServer(db, {
  live,
  device: await readDeviceInfo(HOST_ROOT ? { hostRoot: HOST_ROOT } : {}),
  allowedOrigins: ALLOWED_ORIGINS,
  ...(existsSync(WEB_DIR) ? { webRoot: WEB_DIR } : {}),
  plugins: builtinPlugins.map(({ id, label, unit, intervalMs }) => ({
    id,
    label,
    unit,
    intervalMs,
    ...(UNAVAILABLE.has(id) ? { unavailable: CONTAINER_UNAVAILABLE } : {})
  })),
  alertRules: { source: RULES, recheck: () => engine.alerts?.check() },
  alertFeed,
  auth: { protectReads: PROTECT_READS, ...(PASSWORD_HASH ? { passwordHash: PASSWORD_HASH } : {}) },
  settings: { getRetention, metrics: METRICS, rawAtLeast: () => longestLookBack(rulesInForce()) },
  notify: notifications,
  health,
  version: VERSION,
  node: NODE
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
const scheduler = startScheduler(db, RUN_PLUGINS, {
  onSample: (sample) => {
    health.markReading();
    live.publish(sample);
  },
  onError: (plugin, error) => {
    console.error(`[pipulse] ${plugin.id} failed:`, error);
  }
});
// Checks every alert rule now and then every 15 s; raises and clears go to /api/live.
engine.alerts = startAlerts(db, {
  rules: rulesInForce,
  metrics: RUN_METRICS,
  onChange: (event) => {
    alertFeed.publish(event);
    notifications.enqueue(event);
  },
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
      `[pipulse] ${VERSION} (Node ${NODE.version}) listening on http://${HOST}:${port}` +
        (PASSWORD_HASH ? '' : ' (read-only: PIPULSE_ADMIN_PASSWORD_HASH_FILE not set)') +
        (PROTECT_READS ? ' (reads need sign-in)' : '')
    );
    if (NODE.ended)
      console.warn(
        `[pipulse] Node ${NODE.line} no longer gets security fixes (since ${NODE.supportEnds})`
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
  const [, drained] = await Promise.all([
    app.close(),
    scheduler.stop(SHUTDOWN_TIMEOUT_MS),
    notifications.stop()
  ]);
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
