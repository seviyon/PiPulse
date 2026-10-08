import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server as HttpsServer } from 'node:https';
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
  type AlertContext,
  type AlertEvent,
  type RuleSource
} from '@pipulse/alerts';
import {
  parseNotifyConfig,
  readNotifyFile,
  startNotifications,
  type WebhookConfig
} from '@pipulse/notify';
import { parseDuration } from '@pipulse/storage/duration';
import {
  checkReplacement,
  DEFAULT_RUNTIME_DIR,
  EXPIRING_SOON_MS,
  RELEASE_DEFAULT,
  loadCertificate,
  processIdentity,
  readClock,
  readTlsConfig,
  startReloader,
  statSignature,
  hostName,
  validityOf,
  writeRuntimeStatus,
  type CertSource,
  type CertificateProvider,
  type LoadedCertificate,
  type TlsConfig
} from '@pipulse/tls';
import { readAuthConfig, type AuthConfig } from './auth.js';
import { CONTAINER_UNAVAILABLE, splitForContainer } from './container.js';
import { createHealth } from './health.js';
import { readGeneratedExtras, tlsView, writeTlsMarker } from './tls-status.js';
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

/**
 * HTTPS: resolved and checked before anything else starts, so a refusal is
 * immediate. Refused material stops startup with one line; an expired or
 * not-yet-valid certificate only warns (monitoring must keep running) unless
 * PIPULSE_TLS_REQUIRE_VALID_CERT=true.
 */
function readTls(): TlsConfig {
  try {
    return readTlsConfig(process.env, { releaseDefault: RELEASE_DEFAULT });
  } catch (error) {
    fail(error);
  }
}
const TLS = readTls();
for (const warning of TLS.warnings) console.warn(`[pipulse] warning: ${warning}`);
if (
  TLS.mode !== 'https' &&
  (process.env['PIPULSE_TLS_CERT']?.trim() || process.env['PIPULSE_TLS_KEY']?.trim())
) {
  console.warn(
    '[pipulse] warning: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY are set but HTTPS is off (set PIPULSE_TLS=on)'
  );
}
// Generated files are root-owned with the service's group (6b-2); operator files aren't owner-checked.
const loadActive = (source: CertSource): LoadedCertificate =>
  loadCertificate(source, {
    names: TLS.names,
    generatedOwner: { uid: 0, ...(process.getgid ? { gid: process.getgid() } : {}) }
  });
const certPaths = (source: CertSource): string[] =>
  source.kind === 'operator'
    ? [source.certPath, source.keyPath, ...(source.caPath ? [source.caPath] : [])]
    : [source.bundlePath, source.caPath];
// Read before the startup load, so a renewal landing in between is still picked up by the reloader.
const INITIAL_SIGNATURE =
  TLS.mode === 'https' && TLS.source ? statSignature(certPaths(TLS.source)) : undefined;
function readCertificate(): LoadedCertificate | undefined {
  if (TLS.mode !== 'https' || !TLS.source) return undefined;
  let cert: LoadedCertificate;
  try {
    cert = loadActive(TLS.source);
  } catch (error) {
    fail(error);
  }
  const validity = validityOf(cert, Date.now(), EXPIRING_SOON_MS[cert.source]);
  if (validity === 'expired' || validity === 'not-yet-valid') {
    const clock = readClock({
      timesyncDir: TLS.timesyncDir,
      now: Date.now(),
      trust: TLS.clockTrust
    });
    const excused = validity === 'not-yet-valid' && !clock.synced;
    if (TLS.requireValid && !excused) {
      fail(`the HTTPS certificate is ${validity} and PIPULSE_TLS_REQUIRE_VALID_CERT=true`);
    }
    console.error(
      `[pipulse] SEVERE: the HTTPS certificate is ${validity} (valid ${new Date(cert.notBefore).toISOString()} to ${new Date(cert.notAfter).toISOString()}); browsers will refuse it. Monitoring continues.`
    );
  }
  for (const reason of cert.reasons) {
    console.warn(
      `[pipulse] warning: the HTTPS certificate is ${cert.class} (${reason}${reason === 'san-missing' ? `: ${cert.missingNames.join(', ')}` : ''})`
    );
  }
  return cert;
}
const CERT = readCertificate();

function readHsts(): number | undefined {
  const text = process.env['PIPULSE_TLS_HSTS']?.trim();
  if (!text) return undefined;
  if (TLS.mode !== 'https') {
    console.warn('[pipulse] PIPULSE_TLS_HSTS is ignored: HTTPS is off');
    return undefined;
  }
  try {
    const ms = parseDuration('PIPULSE_TLS_HSTS', text);
    if (!Number.isFinite(ms))
      throw new Error('PIPULSE_TLS_HSTS must be a finite duration, not forever');
    return Math.floor(ms / 1000);
  } catch (error) {
    fail(error);
  }
}
const HSTS_SECONDS = readHsts();

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
      // Certificate rules (built in, from the file or saved) are in force only with HTTPS.
      certificate: TLS.mode === 'https',
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
      console.warn('[pipulse] PIPULSE_NOTIFY_FILE is readable by other users; chmod o-r it');
    return parseNotifyConfig(file);
  } catch (error) {
    fail(error);
  }
}
// Queues a message per alert raise/clear for each webhook and delivers it
// in order, retrying for up to 6 h; survives restarts through the outbox.
const notifications = startNotifications(db, {
  webhooks: readWebhooks(),
  hostname: hostName(),
  metrics: [
    ...builtinPlugins.map(({ id, label, unit }) => ({ id, label, unit })),
    // Certificate alerts have no plugin: the metric id is the one the alerts package stores.
    { id: 'certificate', label: 'HTTPS certificate', unit: '' }
  ],
  log: (message) => console.warn(`[pipulse] ${message}`)
});

// Liveness for /api/health: the database answers and readings keep arriving.
const health = createHealth(db, { trackReadings: true, trackAlertChecks: true });

const live = createLiveFeed();
const alertFeed = createFeed<AlertEvent>();
// buildServer runs before the alert engine starts (below), but its recheck
// hook needs to reach the engine once it exists; held in a property assigned
// later instead of a reassigned `let`.
const tls: { provider?: CertificateProvider } = {};

// What the alert engine needs beyond stored readings. The clock counts as synced for alerts
// only when synced, or unknown with PIPULSE_TLS_CLOCK=trust (the same rule as the health check).
const certificateContext = (): AlertContext => {
  const cert = tls.provider?.current();
  if (!cert) return {};
  const clock = readClock({
    timesyncDir: TLS.timesyncDir,
    now: Date.now(),
    trust: TLS.clockTrust,
    ...(cert.source === 'generated' ? { notBefore: cert.notBefore } : {})
  });
  return { certificate: { notAfter: cert.notAfter, clockSynced: clock.synced } };
};

// systemd's RuntimeDirectory= (and Docker's tmpfs) makes this folder; a dev run has none and
// nothing is written. `pipulse tls status` reads the file, so it needs no HTTP and no session.
const RUNTIME_DIR = process.env['PIPULSE_RUNTIME_DIR']?.trim() || DEFAULT_RUNTIME_DIR;
const IDENTITY = processIdentity(process.pid);
let runtimeWarned = false;
function publishRuntime(): void {
  if (!IDENTITY || !existsSync(RUNTIME_DIR)) return;
  const cert = tls.provider?.current();
  try {
    writeRuntimeStatus(RUNTIME_DIR, {
      version: 1,
      transport: CERT ? 'https' : 'http',
      certificate:
        cert && tls.provider
          ? {
              source: cert.source,
              fingerprint: cert.fingerprint,
              class: cert.class,
              notAfter: cert.notAfter,
              reload: tls.provider.reload()
            }
          : null,
      pid: process.pid,
      ...IDENTITY,
      writtenAt: Date.now()
    });
  } catch (error) {
    if (!runtimeWarned)
      console.warn(
        `[pipulse] could not write ${RUNTIME_DIR}/tls-status.json: ${(error as Error).message}`
      );
    runtimeWarned = true;
  }
}
// Set once the server listens over HTTPS and the data folder's marker could not be written.
let markerProblem: string | undefined;
const engine: { alerts?: { check(): void; stop(): void } } = {};
const app = buildServer(db, {
  live,
  // readDeviceInfo reads the process's own name; the host's (mounted) one wins, as for the certificate.
  device: {
    ...(await readDeviceInfo(HOST_ROOT ? { hostRoot: HOST_ROOT } : {})),
    hostname: hostName()
  },
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
  ...(CERT ? { https: { key: CERT.key, cert: CERT.cert } } : {}),
  ...(HSTS_SECONDS !== undefined ? { hstsSeconds: HSTS_SECONDS } : {}),
  tls: () =>
    tlsView(TLS, tls.provider, Date.now(), {
      ...(TLS.source?.kind === 'generated' ? { extras: readGeneratedExtras(TLS.dir) } : {}),
      ...(markerProblem ? { markerProblem } : {}),
      inContainer: IN_CONTAINER
    }),
  version: VERSION,
  node: NODE
});
if (CERT && TLS.source) {
  const source = TLS.source;
  // Picks up a replaced certificate within about two minutes, without a restart.
  tls.provider = startReloader({
    initial: CERT,
    ...(INITIAL_SIGNATURE !== undefined ? { initialSignature: INITIAL_SIGNATURE } : {}),
    load: () => loadActive(source),
    signature: () => statSignature(certPaths(source)),
    accept: (candidate, active) =>
      checkReplacement(candidate, active, {
        requireValid: TLS.requireValid,
        now: Date.now(),
        timesyncDir: TLS.timesyncDir,
        clockTrust: TLS.clockTrust
      }),
    apply: (cert) =>
      // setSecureContext replaces the whole context, so the TLS floor is passed again.
      (app.server as unknown as HttpsServer).setSecureContext({
        key: cert.key,
        cert: cert.cert,
        minVersion: 'TLSv1.2'
      }),
    log: (message) => console.warn(`[pipulse] ${message}`),
    onChange: publishRuntime
  });
}
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
  context: certificateContext,
  onNotice: (message) => console.warn(`[pipulse] ${message}`),
  onCheck: () => health.markAlertCheck(),
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
    publishRuntime();
    if (CERT) {
      // Keeps a lost TLS folder from turning an HTTPS install into an HTTP "upgrade" later, so a
      // failed write is loud, in health and in Settings, never swallowed.
      markerProblem = writeTlsMarker(dirname(DB_PATH));
      if (markerProblem) {
        console.error(
          `[pipulse] ERROR: ${markerProblem}: if the TLS folder is ever lost, setup would take this install for an HTTP one. Check the data folder's owner and permissions.`
        );
      }
    }
    const { port } = app.server.address() as AddressInfo;
    const where = CERT
      ? `https://${HOST}:${port} (certificate: ${CERT.source}, valid until ${new Date(CERT.notAfter).toISOString().slice(0, 10)}, SHA-256 ${CERT.fingerprint})`
      : `http://${HOST}:${port} (HTTPS off: ${
          TLS.modeReason === 'env'
            ? 'PIPULSE_TLS=off'
            : TLS.modeReason === 'state'
              ? 'state.json legacy-http'
              : 'release default'
        })`;
    console.log(
      `[pipulse] ${VERSION} (Node ${NODE.version}) listening on ${where}` +
        (PASSWORD_HASH ? '' : ' (read-only: PIPULSE_ADMIN_PASSWORD_HASH_FILE not set)') +
        (PROTECT_READS ? ' (reads need sign-in)' : '')
    );
    if (!CERT && TLS.stateMode === 'legacy-http' && TLS.modeReason === 'state') {
      console.log(
        IN_CONTAINER
          ? '[pipulse] HTTPS is ready: docker compose run --rm pipulse-tls pipulse tls enable --yes, then docker compose restart pipulse'
          : '[pipulse] HTTPS is ready: sudo pipulse tls enable'
      );
    }
    if (!CERT && PASSWORD_HASH) {
      console.warn(
        '[pipulse] warning: sign-in is on but HTTPS is off; the password and the session cookie cross the network unencrypted'
      );
    }
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
  tls.provider?.stop();
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
