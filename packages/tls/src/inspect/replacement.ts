import { readClock } from '../settings/clock.js';
import { CertificateRefused, validityOf, type LoadedCertificate } from './inspect.js';

/** False only when timesyncd is there and says the clock is not synced (or it reads before the floor). */
function clockMayBeRight(options: {
  now: number;
  timesyncDir: string;
  clockTrust: boolean;
}): boolean {
  return (
    readClock({ timesyncDir: options.timesyncDir, now: options.now, trust: options.clockTrust })
      .state !== 'unsynced'
  );
}

/**
 * The validity half of "a reload activates only what startup would accept",
 * plus the downgrade rule: a replacement that is already expired, or not valid yet
 * (unless timesyncd says the clock is not synced), never replaces a certificate that is still good.
 * An `unknown` clock (no timesyncd: chrony, ntpd, Docker) is no evidence that the clock is behind,
 * so it does not excuse a replacement dated in the future; startup is looser because it has no
 * working certificate to keep. Throws CertificateRefused.
 */
export function checkReplacement(
  candidate: LoadedCertificate,
  active: LoadedCertificate,
  options: {
    requireValid: boolean;
    now: number;
    timesyncDir: string;
    clockTrust: boolean;
  }
): void {
  const { now } = options;
  const setting =
    candidate.source === 'generated' ? 'leaf.pem' : 'PIPULSE_TLS_CERT/PIPULSE_TLS_KEY';
  const candidateValidity = validityOf(candidate, now, 0);
  if (candidateValidity === 'expired' && validityOf(active, now, 0) !== 'expired') {
    throw new CertificateRefused(
      `${setting}: the replacement certificate is expired and the active one is not; kept the active one`,
      true
    );
  }
  if (!options.requireValid) {
    if (
      candidateValidity === 'not-yet-valid' &&
      validityOf(active, now, 0) === 'valid' &&
      clockMayBeRight(options)
    ) {
      throw new CertificateRefused(
        `${setting}: the replacement certificate is not valid yet and the active one is; kept the active one`,
        true
      );
    }
    return;
  }
  if (candidateValidity === 'expired') {
    throw new CertificateRefused(
      'PIPULSE_TLS_REQUIRE_VALID_CERT: the replacement certificate is expired',
      true
    );
  }
  if (candidateValidity === 'not-yet-valid') {
    if (clockMayBeRight(options)) {
      throw new CertificateRefused(
        'PIPULSE_TLS_REQUIRE_VALID_CERT: the replacement certificate is not yet valid',
        true
      );
    }
  }
}
