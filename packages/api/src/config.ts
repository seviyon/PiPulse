import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RUNTIME_DIR,
  RELEASE_DEFAULT,
  hostName,
  listenHost,
  listenPort,
  readTlsConfig,
  type TlsConfig
} from '@pipulse/tls';
import { retentionFromEnv } from '@pipulse/storage';
import { parseDuration } from '@pipulse/storage/duration';
import { readAuthConfig, type AuthConfig } from './auth.js';
import { parseAllowedHosts } from './host.js';
import { nodeSupport, readVersion, type NodeSupport } from './version.js';

/** A setting the operator got wrong: the message is the one line printed after `[pipulse] `. */
export class StartupError extends Error {
  override name = 'StartupError';
}

/** Runs `read`, turning whatever it throws into a StartupError with the same message. */
export function refuse<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new StartupError(error instanceof Error ? error.message : String(error));
  }
}

export interface PiPulseConfig {
  dbPath: string;
  host: string;
  port: number;
  webDir: string;
  allowedOrigins: string[];
  /** PIPULSE_ALLOWED_HOSTS, with the host's own names added when it is set; empty = no check. */
  allowedHosts: string[];
  inContainer: boolean;
  hostRoot?: string;
  auth: AuthConfig;
  tls: TlsConfig;
  hstsSeconds?: number;
  runtimeDir: string;
  /** Paths only: the files are read by startServer. */
  alertsFile?: string;
  notifyFile?: string;
  version: string;
  node: NodeSupport;
  /** The environment, for the retention source (it also needs the database). */
  env: NodeJS.ProcessEnv;
  /** Lines to print before anything else, each already `[pipulse] warning: …`. */
  warnings: string[];
}

/** PIPULSE_TLS_HSTS in seconds, or undefined; HTTPS only (HSTS ignores ports). */
function readHsts(env: NodeJS.ProcessEnv, tls: TlsConfig, warnings: string[]): number | undefined {
  const text = env['PIPULSE_TLS_HSTS']?.trim();
  if (!text) return undefined;
  if (tls.mode !== 'https') {
    warnings.push('[pipulse] PIPULSE_TLS_HSTS is ignored: HTTPS is off');
    return undefined;
  }
  const ms = parseDuration('PIPULSE_TLS_HSTS', text);
  if (!Number.isFinite(ms)) {
    throw new Error('PIPULSE_TLS_HSTS must be a finite duration, not forever');
  }
  return Math.floor(ms / 1000);
}

/**
 * Reads and validates every setting the server takes from the environment. Throws a StartupError
 * (one line) for the first bad one; has no side effects: nothing is created, opened or printed.
 */
export function loadConfig(env: NodeJS.ProcessEnv): PiPulseConfig {
  const warnings: string[] = [];
  const auth = refuse(() => readAuthConfig(env));
  const tls = refuse(() => readTlsConfig(env, { releaseDefault: RELEASE_DEFAULT }));
  for (const warning of tls.warnings) warnings.push(`[pipulse] warning: ${warning}`);
  if (tls.mode !== 'https' && (env['PIPULSE_TLS_CERT']?.trim() || env['PIPULSE_TLS_KEY']?.trim())) {
    warnings.push(
      '[pipulse] warning: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY are set but HTTPS is off (set PIPULSE_TLS=on)'
    );
  }
  const port = refuse(() => listenPort(env));
  // The database is not open yet; startServer merges the saved values in. A bad
  // PIPULSE_RETENTION_* is refused here, before anything is opened (decision 6).
  refuse(() => retentionFromEnv(env));
  const hstsSeconds = refuse(() => readHsts(env, tls, warnings));
  const allowedHosts = refuse(() =>
    parseAllowedHosts(env['PIPULSE_ALLOWED_HOSTS'], [
      hostName(),
      `${hostName()}.local`,
      ...tls.names
    ])
  );
  const hostRoot = env['PIPULSE_HOST_ROOT'];
  const alertsFile = env['PIPULSE_ALERTS_FILE'];
  const notifyFile = env['PIPULSE_NOTIFY_FILE'];
  return {
    dbPath: env['PIPULSE_DB_PATH'] ?? 'pipulse.sqlite',
    host: listenHost(env),
    port,
    webDir: env['PIPULSE_WEB_DIR'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
    allowedOrigins: (env['PIPULSE_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
    allowedHosts,
    inContainer: env['PIPULSE_IN_CONTAINER'] === 'true',
    ...(hostRoot ? { hostRoot } : {}),
    auth,
    tls,
    ...(hstsSeconds !== undefined ? { hstsSeconds } : {}),
    runtimeDir: env['PIPULSE_RUNTIME_DIR']?.trim() || DEFAULT_RUNTIME_DIR,
    ...(alertsFile ? { alertsFile } : {}),
    ...(notifyFile ? { notifyFile } : {}),
    // The app root is three levels above packages/api/dist/server.js; a release stamps version.json there.
    version: readVersion(fileURLToPath(new URL('../../../', import.meta.url))),
    node: nodeSupport(),
    env,
    warnings
  };
}
