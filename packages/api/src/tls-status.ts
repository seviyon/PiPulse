import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXPIRING_SOON_MS,
  parseMeta,
  parseRenewStatus,
  readClock,
  validityOf,
  type CaMeta,
  type CertificateProvider,
  type ChainClass,
  type ClockState,
  type Constraints,
  type ModeReason,
  type ReloadState,
  type RenewStatus,
  type StateMode,
  type TlsConfig,
  type Validity
} from '@pipulse/tls';
import type { HealthResult } from './health.js';

export type MetadataFile = 'ca-meta.json' | 'renew-status.json';
/** For /api/config (read-protected): which file, and an errno code or the parser's one line. */
export interface MetadataProblem {
  file: MetadataFile;
  message: string;
}
export interface GeneratedExtras {
  meta?: CaMeta;
  renewal?: RenewStatus;
  problems: MetadataProblem[];
}

const shortMessage = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ??
  (error instanceof Error ? error.message : String(error)).slice(0, 120);

export const TLS_MARKER = 'tls-installed';

/**
 * Marks the data folder as served over HTTPS (setup and the Docker sidecar read it, so a lost TLS
 * folder never turns this install into an HTTP "upgrade"). A one-line problem (an errno code, never
 * a path), or undefined.
 */
export function writeTlsMarker(dataDir: string, now = Date.now()): string | undefined {
  try {
    // Already there (for instance a data folder restored as root, which the service can't
    // rewrite): it does its job, so leave it alone instead of failing on every start.
    lstatSync(join(dataDir, TLS_MARKER));
    return undefined;
  } catch {
    // Absent or not visible: fall through and let the write report what is wrong.
  }
  try {
    writeFileSync(join(dataDir, TLS_MARKER), `${new Date(now).toISOString()}\n`, { mode: 0o640 });
    return undefined;
  } catch (error) {
    return `${TLS_MARKER} could not be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`;
  }
}

/**
 * Public facts about a generated CA and its renewal, read per request (two
 * small files). Only a missing renew-status.json is expected (no renewal has
 * run yet). A missing ca-meta.json (it is written with the CA), any other
 * read error and any content that doesn't validate are problems. Messages
 * are errno codes or the parsers' one-line reasons, never paths or contents.
 */
export function readGeneratedExtras(
  tlsDir: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8')
): GeneratedExtras {
  const extras: GeneratedExtras = { problems: [] };
  function load<T>(
    file: MetadataFile,
    parse: (text: string) => T,
    optional: boolean
  ): T | undefined {
    let text: string;
    try {
      text = read(join(tlsDir, file));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!(missing && optional))
        extras.problems.push({ file, message: missing ? 'missing' : shortMessage(error) });
      return undefined;
    }
    try {
      return parse(text);
    } catch (error) {
      extras.problems.push({ file, message: shortMessage(error) });
      return undefined;
    }
  }
  const meta = load('ca-meta.json', parseMeta, false);
  const renewal = load('renew-status.json', parseRenewStatus, true);
  if (meta) extras.meta = meta;
  if (renewal) extras.renewal = renewal;
  return extras;
}

/** What /api/config serves as `tls` (subject to read protection). */
export type TlsView =
  | { mode: 'http'; reason: ModeReason; stateMode?: StateMode; inContainer: boolean }
  | {
      mode: 'https';
      inContainer: boolean;
      source: 'operator' | 'generated';
      validity: Validity;
      notBefore: number;
      notAfter: number;
      fingerprint: string;
      caFingerprint?: string;
      sans: { dns: string[]; ip: string[] };
      class: ChainClass;
      reasons: string[];
      missingNames: string[];
      certificateAgeMs: number;
      clock: ClockState;
      clockSynced: boolean;
      reload: ReloadState;
      /** Generated certificates only: the served certificate's CA (never a scope it doesn't have). */
      ca?:
        | {
            state: 'ok';
            subject: string;
            createdAt: number;
            notAfter: number;
            constraints: Constraints;
            backups: number;
          }
        | { state: 'transitional' }
        | { state: 'unavailable' };
      /** Present only with `ca.state === 'ok'`. */
      coverage?: { dns: string[]; ipSubnets: string[] };
      renewal?: {
        state: 'ok' | 'waiting-clock' | 'failing' | 'unknown';
        lastAttempt: number | null;
        result: RenewStatus['result'] | null;
        reason: string | null;
      };
      metadata?: 'ok' | 'transitional' | 'unreadable';
      metadataProblems?: MetadataProblem[];
      /** The data folder's tls-installed marker could not be written (one line, no path). */
      markerProblem?: string;
    };

export function tlsView(
  config: TlsConfig,
  provider: CertificateProvider | undefined,
  now: number,
  options: { extras?: GeneratedExtras; inContainer?: boolean; markerProblem?: string } = {}
): TlsView {
  const inContainer = options.inContainer ?? false;
  if (config.mode === 'http' || !provider) {
    return {
      mode: 'http',
      reason: config.modeReason,
      ...(config.stateMode !== undefined ? { stateMode: config.stateMode } : {}),
      inContainer
    };
  }
  const cert = provider.current();
  const extras = cert.source === 'generated' ? (options.extras ?? { problems: [] }) : undefined;
  type Https = Extract<TlsView, { mode: 'https' }>;
  let ca: Https['ca'];
  if (extras) {
    if (!extras.meta) ca = { state: 'unavailable' };
    // ca-meta.json must describe the CA of the certificate being SERVED: a CA
    // change installs it before the reloader switches to the new leaf.
    else if (cert.caFingerprint === undefined || extras.meta.fingerprint !== cert.caFingerprint)
      ca = { state: 'transitional' };
    else {
      ca = {
        state: 'ok',
        subject: extras.meta.subject,
        createdAt: extras.meta.createdAt,
        notAfter: extras.meta.notAfter,
        constraints: extras.meta.constraints,
        backups: extras.meta.backups.length
      };
    }
  }
  const renewal = extras && {
    state: !extras.renewal
      ? ('unknown' as const)
      : extras.renewal.result === 'failed'
        ? ('failing' as const)
        : extras.renewal.result === 'waiting-clock'
          ? ('waiting-clock' as const)
          : ('ok' as const),
    lastAttempt: extras.renewal?.lastAttempt ?? null,
    result: extras.renewal?.result ?? null,
    reason: extras.renewal?.reason ?? null
  };
  const metadata =
    extras &&
    (extras.problems.length > 0
      ? ('unreadable' as const)
      : ca?.state === 'transitional'
        ? ('transitional' as const)
        : ('ok' as const));
  const clock = readClock({
    timesyncDir: config.timesyncDir,
    now,
    trust: config.clockTrust,
    ...(cert.source === 'generated' ? { notBefore: cert.notBefore } : {})
  });
  return {
    mode: 'https',
    inContainer,
    source: cert.source,
    validity: validityOf(cert, now, EXPIRING_SOON_MS[cert.source]),
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    fingerprint: cert.fingerprint,
    ...(cert.caFingerprint !== undefined ? { caFingerprint: cert.caFingerprint } : {}),
    sans: cert.sans,
    class: cert.class,
    reasons: cert.reasons,
    missingNames: cert.missingNames,
    certificateAgeMs: now - cert.notBefore,
    clock: clock.state,
    clockSynced: clock.synced,
    reload: provider.reload(),
    ...(ca ? { ca } : {}),
    ...(ca?.state === 'ok'
      ? { coverage: { dns: ca.constraints.dns, ipSubnets: ca.constraints.subnets } }
      : {}),
    ...(renewal ? { renewal } : {}),
    ...(metadata ? { metadata } : {}),
    ...(extras && extras.problems.length > 0 ? { metadataProblems: extras.problems } : {}),
    ...(options.markerProblem ? { markerProblem: options.markerProblem } : {})
  };
}

/**
 * /api/health: public, so enums only — no paths, fingerprints, names or
 * settings. `certificate` describes the certificate being served. There is
 * always one in HTTPS mode (refused material stops startup, and a refused
 * replacement never replaces it), so parse/key-match of the active pair are
 * never anything but ok and aren't reported; a refused *replacement* shows as
 * reload 'failing', or 'no-valid-reload' when the served one has expired.
 */
export interface HealthBody {
  status: 'ok' | 'degraded' | 'failing';
  monitoring: 'ok' | 'failing';
  transport: 'http' | 'https';
  problems?: string[];
  reasons?: string[];
  certificate?: {
    source: 'operator' | 'generated';
    validity: Validity;
    clockSynced: ClockState;
    class: ChainClass;
    reload: 'ok' | 'failing' | 'no-valid-reload';
    renewal?: 'ok' | 'waiting-clock' | 'failing' | 'unknown';
    metadata?: 'ok' | 'transitional' | 'unreadable';
  };
}

/**
 * failing (503) only when monitoring fails; a certificate problem alone is
 * degraded (200), because collection, alerts and notifications keep running.
 */
export function healthBody(
  result: HealthResult,
  tls: TlsView | undefined,
  signInConfigured: boolean
): HealthBody {
  const reasons: string[] = [];
  let certificate: HealthBody['certificate'];
  if (tls?.mode === 'https') {
    if (tls.validity === 'expired' || tls.validity === 'not-yet-valid') reasons.push(tls.validity);
    reasons.push(...tls.reasons);
    const reload =
      tls.reload.state === 'ok' ? 'ok' : tls.validity === 'expired' ? 'no-valid-reload' : 'failing';
    if (reload !== 'ok') reasons.push(reload === 'failing' ? 'reload-failing' : reload);
    if (tls.source === 'generated' && !tls.clockSynced) reasons.push(`clock-${tls.clock}`);
    if (tls.renewal?.state === 'failing') reasons.push('renewal-failing');
    if (tls.metadata === 'unreadable') reasons.push('generated-metadata-unreadable');
    if (tls.markerProblem) reasons.push('tls-marker-unwritten');
    certificate = {
      source: tls.source,
      validity: tls.validity,
      clockSynced: tls.clock,
      class: tls.class,
      reload,
      ...(tls.renewal ? { renewal: tls.renewal.state } : {}),
      ...(tls.metadata ? { metadata: tls.metadata } : {})
    };
  } else if (signInConfigured) {
    reasons.push('http-with-sign-in');
  }
  return {
    status: !result.ok ? 'failing' : reasons.length > 0 ? 'degraded' : 'ok',
    monitoring: result.ok ? 'ok' : 'failing',
    transport: tls?.mode ?? 'http',
    ...(result.ok ? {} : { problems: result.problems }),
    ...(reasons.length > 0 ? { reasons } : {}),
    ...(certificate ? { certificate } : {})
  };
}
