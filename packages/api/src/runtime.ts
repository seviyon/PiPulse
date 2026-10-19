import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { cpus } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server as HttpsServer } from 'node:https';
import type { FastifyInstance } from 'fastify';
import {
  openDb,
  policyOf,
  retentionSource,
  startHousekeeping,
  type PiPulseDb,
  type RetentionSettings
} from '@pipulse/storage';
import {
  builtinPlugins,
  describePluginError,
  readDeviceInfo,
  startScheduler,
  type CollectorPlugin
} from '@pipulse/collector';
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
  type Notifications,
  type WebhookConfig
} from '@pipulse/notify';
import { hostName, type CertificateProvider } from '@pipulse/tls';
import { buildServer } from './app.js';
import { refuse, StartupError, type PiPulseConfig } from './config.js';
import { CONTAINER_UNAVAILABLE, splitForContainer } from './container.js';
import { createFeed, createLiveFeed } from './feed.js';
import { createHealth } from './health.js';
import type { DeviceInfo } from './options.js';
import { longestLookBack, rawRetentionProblem } from './settings-routes.js';
import { readGeneratedExtras, tlsView, writeTlsMarker } from './tls-status.js';
import {
  certificateAlertContext,
  createRuntimeStatus,
  initialSignatureOf,
  loadServingCertificate,
  startCertificateReloader
} from './tls-runtime.js';
import { createUpdates } from './updates.js';

/** How long shutdown waits for in-flight sensor reads before giving up on them. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

export interface StartOverrides {
  plugins?: CollectorPlugin[];
  device?: DeviceInfo;
  /** How long stop() waits for in-flight sensor reads; default SHUTDOWN_TIMEOUT_MS (5000). */
  shutdownTimeoutMs?: number;
}

export interface RunningServer {
  app: FastifyInstance;
  address(): { host: string; port: number };
  /** Idempotent: every call returns the same promise. */
  stop(): Promise<{ drained: boolean }>;
}

/** What has been started so far, so a failure part-way through can stop exactly that. */
interface Parts {
  db: PiPulseDb;
  notifications?: Notifications;
  updates?: ReturnType<typeof createUpdates>;
  app?: FastifyInstance;
  provider?: CertificateProvider;
  housekeeping?: ReturnType<typeof startHousekeeping>;
  scheduler?: ReturnType<typeof startScheduler>;
  alerts?: ReturnType<typeof startAlerts>;
}

async function stopParts(parts: Parts, shutdownTimeoutMs: number): Promise<{ drained: boolean }> {
  parts.provider?.stop();
  parts.housekeeping?.stop();
  parts.alerts?.stop();
  parts.updates?.stop();
  const [, drained] = await Promise.all([
    parts.app?.close(),
    parts.scheduler?.stop(shutdownTimeoutMs) ?? true,
    parts.notifications?.stop()
  ]);
  parts.db.close();
  return { drained };
}

/** Webhooks from PIPULSE_NOTIFY_FILE, if set; a bad file stops startup with one line. */
function readWebhooks(path: string | undefined): WebhookConfig[] {
  if (!path) return [];
  return refuse(() => {
    const file = readNotifyFile(path);
    if (file.worldReadable)
      console.warn('[pipulse] PIPULSE_NOTIFY_FILE is readable by other users; chmod o-r it');
    return parseNotifyConfig(file);
  });
}

/**
 * PiPulse server: one process that runs the collector scheduler and serves the REST API plus the
 * /api/live WebSocket. Each sample the scheduler writes is pushed straight to connected clients.
 * Refusals (a bad setting, certificate or file) throw a StartupError before anything is opened;
 * a failure after the database is open stops whatever had started and rethrows as it was.
 */
export async function startServer(
  config: PiPulseConfig,
  overrides: StartOverrides = {}
): Promise<RunningServer> {
  const shutdownTimeoutMs = overrides.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  for (const warning of config.warnings) console.warn(warning);

  // In a container (the Docker image sets these) the firmware plugins can't run, and
  // the host's OS name and Pi model are mounted under PIPULSE_HOST_ROOT.
  const plugins = overrides.plugins ?? builtinPlugins;
  const { run: runPlugins, unavailable } = splitForContainer(plugins, config.inContainer);
  const metrics = plugins.map(({ id, intervalMs }) => ({ id, intervalMs }));
  // What the engine watches: only plugins that run here, so the '*' silence rule
  // (not_collecting) never waits on a plugin a container can't schedule.
  const runMetrics = runPlugins.map(({ id, intervalMs }) => ({ id, intervalMs }));

  // Read before the startup load, so a renewal landing in between is still picked up.
  const initialSignature = initialSignatureOf(config.tls);
  const certificate = loadServingCertificate(config.tls);

  const parts: Parts = { db: openDb(config.dbPath) };
  const { db } = parts;
  const tls: { provider?: CertificateProvider } = {};
  // The alert engine's recheck hook is reached through a property assigned once it exists.
  const engine: { alerts?: { check(): void; stop(): void } } = {};
  // Set once the server listens over HTTPS and the data folder's marker could not be written.
  let markerProblem: string | undefined;
  try {
    /**
     * Retention in force: PIPULSE_RETENTION_* over values saved from the Settings page over
     * defaults, re-read on every housekeeping run. Resolved once here so a bad value stops startup.
     */
    const getRetention = retentionSource(db, config.env, (message) =>
      console.warn(`[pipulse] ${message}`)
    );
    const retention: RetentionSettings = refuse(() => getRetention());

    /**
     * Alert rules: built-ins, PIPULSE_ALERTS_FILE over them, and rules saved from the browser over
     * both, re-read on every check. A bad file stops startup with one line; a bad saved rule is
     * logged and skipped.
     */
    const rules: RuleSource = refuse(() =>
      createRuleSource(db, {
        cores: cpus().length,
        metrics,
        rawRetention: () => {
          const raw = getRetention().raw;
          return { ms: raw.ms, text: raw.text };
        },
        onProblem: (message) => console.warn(`[pipulse] ${message}`),
        // Certificate rules (built in, from the file or saved) are in force only with HTTPS.
        certificate: config.tls.mode === 'https',
        ...(config.alertsFile ? { file: readRulesFile(config.alertsFile) } : {})
      })
    );
    // Only rules in force must fit the raw retention in force. The file and built-in rules in
    // force are checked here; saved rules that don't fit are skipped instead (see
    // createRuleSource), and a rule disabled from the browser never runs, so it isn't checked.
    const baseLookBack = longestLookBack(
      rules.read().rules.filter((rule) => rule.source !== 'saved')
    );
    const rawProblem = rawRetentionProblem(retention.raw, baseLookBack);
    if (rawProblem) throw new StartupError(rawProblem);
    const rulesInForce = () => rules.read().rules;

    // Queues a message per alert raise/clear for each webhook and delivers it
    // in order, retrying for up to 6 h; survives restarts through the outbox.
    const notifications = startNotifications(db, {
      webhooks: readWebhooks(config.notifyFile),
      hostname: hostName(),
      metrics: [
        ...plugins.map(({ id, label, unit }) => ({ id, label, unit })),
        // Certificate alerts have no plugin: the metric id is the one the alerts package stores.
        { id: 'certificate', label: 'HTTPS certificate', unit: '' }
      ],
      log: (message) => console.warn(`[pipulse] ${message}`)
    });
    parts.notifications = notifications;

    // Liveness for /api/health: the database answers and readings keep arriving.
    const health = createHealth(db, { trackReadings: true, trackAlertChecks: true });
    const live = createLiveFeed();
    const alertFeed = createFeed<AlertEvent>();
    const runtimeStatus = createRuntimeStatus({
      runtimeDir: config.runtimeDir,
      certificate,
      provider: () => tls.provider,
      warn: (message) => console.warn(`[pipulse] ${message}`)
    });
    // What `apt-get upgrade` would do, checked 2 minutes after start and every 6 hours (nothing in a container).
    const updates = createUpdates({
      inContainer: config.inContainer,
      onError: (error) =>
        console.error(`updates check failed: ${(error as Error).message.split('\n')[0]}`)
    });
    parts.updates = updates;

    const app = buildServer(db, {
      live,
      // readDeviceInfo reads the process's own name; the host's (mounted) one wins, as for the certificate.
      device: overrides.device ?? {
        ...(await readDeviceInfo(config.hostRoot ? { hostRoot: config.hostRoot } : {})),
        hostname: hostName()
      },
      allowedOrigins: config.allowedOrigins,
      allowedHosts: config.allowedHosts,
      ...(existsSync(config.webDir) ? { webRoot: config.webDir } : {}),
      plugins: plugins.map(({ id, label, unit, intervalMs }) => ({
        id,
        label,
        unit,
        intervalMs,
        ...(unavailable.has(id) ? { unavailable: CONTAINER_UNAVAILABLE } : {})
      })),
      alertRules: { source: rules, recheck: () => engine.alerts?.check() },
      alertFeed,
      auth: {
        protectReads: config.auth.protectReads,
        ...(config.auth.passwordHash ? { passwordHash: config.auth.passwordHash } : {})
      },
      settings: { getRetention, metrics, rawAtLeast: () => longestLookBack(rulesInForce()) },
      notify: notifications,
      updates,
      health,
      ...(certificate ? { https: { key: certificate.key, cert: certificate.cert } } : {}),
      ...(config.hstsSeconds !== undefined ? { hstsSeconds: config.hstsSeconds } : {}),
      tls: () =>
        tlsView(config.tls, tls.provider, Date.now(), {
          ...(config.tls.source?.kind === 'generated'
            ? { extras: readGeneratedExtras(config.tls.dir) }
            : {}),
          ...(markerProblem ? { markerProblem } : {}),
          inContainer: config.inContainer
        }),
      version: config.version,
      node: config.node
    });
    parts.app = app;

    if (certificate && config.tls.source) {
      tls.provider = startCertificateReloader({
        tls: config.tls,
        certificate,
        initialSignature,
        // setSecureContext replaces the whole context, so the TLS floor is passed again.
        apply: (cert) =>
          (app.server as unknown as HttpsServer).setSecureContext({
            key: cert.key,
            cert: cert.cert,
            minVersion: 'TLSv1.2'
          }),
        log: (message) => console.warn(`[pipulse] ${message}`),
        onChange: () => runtimeStatus.publish()
      });
      parts.provider = tls.provider;
    }
    // Rolls raw samples up into 1m/1h/1d buckets and prunes past retention, every
    // minute, re-reading saved retention each run; compacts the file after big deletes.
    parts.housekeeping = startHousekeeping(db, {
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
    parts.scheduler = startScheduler(db, runPlugins, {
      onSample: (sample) => {
        health.markReading();
        live.publish(sample);
      },
      onError: (plugin, error) => {
        console.error(`[pipulse] ${plugin.id} failed:`, describePluginError(error));
      }
    });
    // Checks every alert rule now and then every 15 s; raises and clears go to /api/live.
    parts.alerts = engine.alerts = startAlerts(db, {
      rules: rulesInForce,
      metrics: runMetrics,
      context: certificateAlertContext(config.tls, () => tls.provider),
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

    await app.listen({ port: config.port, host: config.host });

    runtimeStatus.publish();
    if (certificate) {
      // Keeps a lost TLS folder from turning an HTTPS install into an HTTP "upgrade" later, so a
      // failed write is loud, in health and in Settings, never swallowed.
      markerProblem = writeTlsMarker(dirname(config.dbPath));
      if (markerProblem) {
        console.error(
          `[pipulse] ERROR: ${markerProblem}: if the TLS folder is ever lost, setup would take this install for an HTTP one. Check the data folder's owner and permissions.`
        );
      }
    }
    const { port } = app.server.address() as AddressInfo;
    const where = certificate
      ? `https://${config.host}:${port} (certificate: ${certificate.source}, valid until ${new Date(certificate.notAfter).toISOString().slice(0, 10)}, SHA-256 ${certificate.fingerprint})`
      : `http://${config.host}:${port} (HTTPS off: ${
          config.tls.modeReason === 'env'
            ? 'PIPULSE_TLS=off'
            : config.tls.modeReason === 'state'
              ? 'state.json legacy-http'
              : 'release default'
        })`;
    console.log(
      `[pipulse] ${config.version} (Node ${config.node.version}) listening on ${where}` +
        (config.auth.passwordHash ? '' : ' (read-only: PIPULSE_ADMIN_PASSWORD_HASH_FILE not set)') +
        (config.auth.protectReads ? ' (reads need sign-in)' : '')
    );
    if (
      !certificate &&
      config.tls.stateMode === 'legacy-http' &&
      config.tls.modeReason === 'state'
    ) {
      console.log(
        config.inContainer
          ? '[pipulse] HTTPS is ready: docker compose run --rm pipulse-tls pipulse tls enable --yes, then docker compose restart pipulse'
          : '[pipulse] HTTPS is ready: sudo pipulse tls enable'
      );
    }
    if (!certificate && config.auth.passwordHash) {
      console.warn(
        '[pipulse] warning: sign-in is on but HTTPS is off; the password and the session cookie cross the network unencrypted'
      );
    }
    if (config.node.ended)
      console.warn(
        `[pipulse] Node ${config.node.line} no longer gets security fixes (since ${config.node.supportEnds})`
      );
    updates.start();

    let stopping: Promise<{ drained: boolean }> | undefined;
    return {
      app,
      address: () => ({ host: config.host, port }),
      stop: () => (stopping ??= stopParts(parts, shutdownTimeoutMs))
    };
  } catch (error) {
    await stopParts(parts, shutdownTimeoutMs);
    throw error;
  }
}
