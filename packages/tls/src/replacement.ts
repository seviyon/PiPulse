import { readClock } from './clock.js';
import { CertificateRefused, validityOf, type LoadedCertificate } from './inspect.js';

/**
 * The validity half of "a reload activates only what startup would accept",
 * plus the downgrade rule: a replacement that is already expired never
 * replaces a certificate that is still good. Throws CertificateRefused.
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
  const candidateValidity = validityOf(candidate, now, 0);
  if (candidateValidity === 'expired' && validityOf(active, now, 0) !== 'expired') {
    throw new CertificateRefused(
      'PIPULSE_TLS_CERT/PIPULSE_TLS_KEY: the replacement certificate is expired and the active one is not; kept the active one',
      true
    );
  }
  if (!options.requireValid) return;
  if (candidateValidity === 'expired') {
    throw new CertificateRefused(
      'PIPULSE_TLS_REQUIRE_VALID_CERT: the replacement certificate is expired',
      true
    );
  }
  if (candidateValidity === 'not-yet-valid') {
    const clock = readClock({
      timesyncDir: options.timesyncDir,
      now,
      trust: options.clockTrust
    });
    if (clock.synced) {
      throw new CertificateRefused(
        'PIPULSE_TLS_REQUIRE_VALID_CERT: the replacement certificate is not yet valid',
        true
      );
    }
  }
}
