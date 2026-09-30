import {
  EXPIRING_SOON_MS,
  readClock,
  validityOf,
  type CertificateProvider,
  type ChainClass,
  type ClockState,
  type ModeReason,
  type ReloadState,
  type StateMode,
  type TlsConfig,
  type Validity
} from '@pipulse/tls';
import type { HealthResult } from './health.js';

/** What /api/config serves as `tls` (subject to read protection). */
export type TlsView =
  | { mode: 'http'; reason: ModeReason; stateMode?: StateMode }
  | {
      mode: 'https';
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
    };

export function tlsView(
  config: TlsConfig,
  provider: CertificateProvider | undefined,
  now: number
): TlsView {
  if (config.mode === 'http' || !provider) {
    return {
      mode: 'http',
      reason: config.modeReason,
      ...(config.stateMode !== undefined ? { stateMode: config.stateMode } : {})
    };
  }
  const cert = provider.current();
  const clock = readClock({
    timesyncDir: config.timesyncDir,
    now,
    trust: config.clockTrust,
    ...(cert.source === 'generated' ? { notBefore: cert.notBefore } : {})
  });
  return {
    mode: 'https',
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
    reload: provider.reload()
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
    certificate = {
      source: tls.source,
      validity: tls.validity,
      clockSynced: tls.clock,
      class: tls.class,
      reload
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
