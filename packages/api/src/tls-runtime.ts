import { existsSync } from 'node:fs';
import type { AlertContext } from '@pipulse/alerts';
import {
  checkReplacement,
  EXPIRING_SOON_MS,
  loadCertificate,
  processIdentity,
  readClock,
  startReloader,
  statSignature,
  validityOf,
  writeRuntimeStatus,
  type CertSource,
  type CertificateProvider,
  type LoadedCertificate,
  type TlsConfig
} from '@pipulse/tls';
import { refuse, StartupError } from './config.js';

// Generated files are root-owned with the service's group (6b-2); operator files aren't owner-checked.
const loadActive = (tls: TlsConfig, source: CertSource): LoadedCertificate =>
  loadCertificate(source, {
    names: tls.names,
    generatedOwner: { uid: 0, ...(process.getgid ? { gid: process.getgid() } : {}) }
  });
const certPaths = (source: CertSource): string[] =>
  source.kind === 'operator'
    ? [source.certPath, source.keyPath, ...(source.caPath ? [source.caPath] : [])]
    : [source.bundlePath, source.caPath];

/**
 * The file signature of the certificate files, read before the startup load, so a renewal landing
 * in between is still picked up by the reloader.
 */
export function initialSignatureOf(tls: TlsConfig): string | undefined {
  return tls.mode === 'https' && tls.source ? statSignature(certPaths(tls.source)) : undefined;
}

/**
 * HTTPS: resolved and checked before anything else starts, so a refusal is
 * immediate. Refused material stops startup with one line (a StartupError); an expired or
 * not-yet-valid certificate only warns (monitoring must keep running) unless
 * PIPULSE_TLS_REQUIRE_VALID_CERT=true. Undefined when the server speaks plain HTTP.
 */
export function loadServingCertificate(tls: TlsConfig): LoadedCertificate | undefined {
  if (tls.mode !== 'https' || !tls.source) return undefined;
  const source = tls.source;
  const cert = refuse(() => loadActive(tls, source));
  const validity = validityOf(cert, Date.now(), EXPIRING_SOON_MS[cert.source]);
  if (validity === 'expired' || validity === 'not-yet-valid') {
    const clock = readClock({
      timesyncDir: tls.timesyncDir,
      now: Date.now(),
      trust: tls.clockTrust
    });
    const excused = validity === 'not-yet-valid' && !clock.synced;
    if (tls.requireValid && !excused) {
      throw new StartupError(
        `the HTTPS certificate is ${validity} and PIPULSE_TLS_REQUIRE_VALID_CERT=true`
      );
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

/**
 * What the alert engine needs beyond stored readings. The clock counts as synced for alerts
 * only when synced, or unknown with PIPULSE_TLS_CLOCK=trust (the same rule as the health check).
 */
export function certificateAlertContext(
  tls: TlsConfig,
  provider: () => CertificateProvider | undefined
): () => AlertContext {
  return () => {
    const cert = provider()?.current();
    if (!cert) return {};
    const clock = readClock({
      timesyncDir: tls.timesyncDir,
      now: Date.now(),
      trust: tls.clockTrust
    });
    return { certificate: { notAfter: cert.notAfter, clockSynced: clock.synced } };
  };
}

export interface RuntimeStatusWriter {
  publish(): void;
}

/**
 * Publishes what the server serves in `<runtimeDir>/tls-status.json`. systemd's RuntimeDirectory=
 * (and Docker's tmpfs) makes the folder; a dev run has none and nothing is written. `pipulse tls
 * status` reads the file, so it needs no HTTP and no session. A failed write warns once.
 */
export function createRuntimeStatus(options: {
  runtimeDir: string;
  certificate: LoadedCertificate | undefined;
  provider: () => CertificateProvider | undefined;
  warn: (message: string) => void;
  /** Default: processIdentity(process.pid), which is undefined off Linux (then nothing is written). */
  identity?: () => { startTime: string; bootId: string } | undefined;
}): RuntimeStatusWriter {
  const { runtimeDir, certificate, provider, warn } = options;
  const identity = (options.identity ?? (() => processIdentity(process.pid)))();
  let warned = false;
  return {
    publish() {
      if (!identity || !existsSync(runtimeDir)) return;
      const active = provider();
      const cert = active?.current();
      try {
        writeRuntimeStatus(runtimeDir, {
          version: 1,
          transport: certificate ? 'https' : 'http',
          certificate:
            cert && active
              ? {
                  source: cert.source,
                  fingerprint: cert.fingerprint,
                  class: cert.class,
                  notAfter: cert.notAfter,
                  reload: active.reload()
                }
              : null,
          pid: process.pid,
          ...identity,
          writtenAt: Date.now()
        });
      } catch (error) {
        if (!warned)
          warn(`could not write ${runtimeDir}/tls-status.json: ${(error as Error).message}`);
        warned = true;
      }
    }
  };
}

/** Picks up a replaced certificate within about two minutes, without a restart. */
export function startCertificateReloader(options: {
  tls: TlsConfig;
  certificate: LoadedCertificate;
  initialSignature: string | undefined;
  apply: (cert: LoadedCertificate) => void;
  log: (message: string) => void;
  onChange: () => void;
}): CertificateProvider {
  const { tls, certificate, initialSignature, apply, log, onChange } = options;
  const source = tls.source;
  if (!source) throw new Error('startCertificateReloader needs a certificate source');
  return startReloader({
    initial: certificate,
    ...(initialSignature !== undefined ? { initialSignature } : {}),
    load: () => loadActive(tls, source),
    signature: () => statSignature(certPaths(source)),
    accept: (candidate, active) =>
      checkReplacement(candidate, active, {
        requireValid: tls.requireValid,
        now: Date.now(),
        timesyncDir: tls.timesyncDir,
        clockTrust: tls.clockTrust
      }),
    apply,
    log,
    onChange
  });
}
