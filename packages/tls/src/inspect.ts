import { createHash, createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { basename } from 'node:path';
import { rootCertificates } from 'node:tls';
import type { CertSource } from './config.js';
import { readSecureFile } from './files.js';
import { parseBundle, parseCertificateFile, parseKeyFile } from './pem.js';

export type Validity = 'valid' | 'expiring-soon' | 'expired' | 'not-yet-valid';
export type ChainClass =
  'valid' | 'degraded-incomplete-chain' | 'degraded-san' | 'degraded-untrusted';

/** Higher is better, in the order clients cope with each class. */
export const CLASS_RANK: Record<ChainClass, number> = {
  valid: 3,
  'degraded-incomplete-chain': 2,
  'degraded-san': 1,
  'degraded-untrusted': 0
};

const DAY_MS = 86_400_000;
export const EXPIRING_SOON_MS = { operator: 14 * DAY_MS, generated: 30 * DAY_MS } as const;

/** Material that must never be served: startup stops, a reload keeps the old context. */
export class CertificateRefused extends Error {
  override name = 'CertificateRefused';
  /** True when the message already starts with the setting or file it is about. */
  readonly named: boolean;
  constructor(message: string, named = false) {
    super(message);
    this.named = named;
  }
}

/** What the chain must lead to: explicit anchors, and/or Node's bundled roots. */
export interface Trust {
  anchors: string[];
  system: boolean;
}

export interface LoadedCertificate {
  source: 'operator' | 'generated';
  /** For tls.createSecureContext. */
  key: string;
  cert: string;
  /** SHA-256 of the leaf, colon-separated hex. */
  fingerprint: string;
  /** SHA-256 of the complete key and certificate chain served to clients. */
  contextFingerprint: string;
  /**
   * Unix ms: when the served chain is valid — the latest start and earliest
   * end among the leaf and its intermediates (a trusted root is left out).
   */
  notBefore: number;
  notAfter: number;
  sans: { dns: string[]; ip: string[] };
  class: ChainClass;
  /** Machine-readable: 'incomplete-chain', 'untrusted', 'san-missing'. */
  reasons: string[];
  /** PIPULSE_TLS_NAMES entries the leaf doesn't cover. */
  missingNames: string[];
  caFingerprint?: string;
}

export function parseSans(text: string | undefined): { dns: string[]; ip: string[] } {
  const dns: string[] = [];
  const ip: string[] = [];
  for (const part of (text ?? '').split(', ')) {
    if (part.startsWith('DNS:')) dns.push(part.slice(4));
    else if (part.startsWith('IP Address:')) ip.push(part.slice(11));
  }
  return { dns, ip };
}

export function validityOf(
  cert: { notBefore: number; notAfter: number },
  now: number,
  soonMs: number
): Validity {
  if (now < cert.notBefore) return 'not-yet-valid';
  if (now >= cert.notAfter) return 'expired';
  if (cert.notAfter - now <= soonMs) return 'expiring-soon';
  return 'valid';
}

let systemRoots: X509Certificate[] | undefined;
const loadSystemRoots = () =>
  (systemRoots ??= rootCertificates.map((pem) => new X509Certificate(pem)));

const issuedBy = (child: X509Certificate, parent: X509Certificate) =>
  child.checkIssued(parent) && child.verify(parent.publicKey);

/**
 * Checks certificate + key the way startup and every reload do. Refuses
 * (throws CertificateRefused) what must never be served; otherwise returns
 * the material with its class — the worst that applies — and reasons.
 */
export function inspectMaterial(input: {
  source: 'operator' | 'generated';
  keyPem: string;
  certPems: string[];
  trust: Trust;
  names: string[];
}): LoadedCertificate {
  const certs = input.certPems.map((pem, i) => {
    try {
      return new X509Certificate(pem);
    } catch {
      throw new CertificateRefused(`certificate ${i + 1} can't be parsed`);
    }
  });
  let key: KeyObject;
  try {
    key = createPrivateKey(input.keyPem);
  } catch {
    throw new CertificateRefused("the private key can't be parsed");
  }
  const leaf = certs[0]!;
  if (!leaf.checkPrivateKey(key)) {
    throw new CertificateRefused('the private key does not match the first certificate');
  }
  if (leaf.ca) {
    throw new CertificateRefused(
      'the first certificate is a CA certificate, not a server certificate'
    );
  }
  const seen = new Set<string>();
  for (const cert of certs) {
    if (seen.has(cert.fingerprint256))
      throw new CertificateRefused('the chain holds the same certificate twice');
    seen.add(cert.fingerprint256);
  }
  for (let i = 0; i + 1 < certs.length; i++) {
    if (!issuedBy(certs[i]!, certs[i + 1]!)) {
      throw new CertificateRefused(
        `certificate ${i + 2} did not issue certificate ${i + 1} (wrong order, an unrelated certificate, or a bad signature)`
      );
    }
  }

  // Only a CA can issue: a server certificate further up the chain is refused
  // even when its name and signature happen to line up.
  for (let i = 1; i < certs.length; i++) {
    if (!certs[i]!.ca) {
      throw new CertificateRefused(
        `certificate ${i + 1} is not a CA certificate, so it can't have issued certificate ${i}`
      );
    }
  }

  let chainClass: ChainClass = 'valid';
  const reasons: string[] = [];
  const degrade = (to: ChainClass, reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    if (CLASS_RANK[to] < CLASS_RANK[chainClass]) chainClass = to;
  };

  const anchorName = input.source === 'generated' ? 'ca.crt' : 'PIPULSE_TLS_CA';
  const anchors = input.trust.anchors
    .map((pem, i) => {
      try {
        return new X509Certificate(pem);
      } catch {
        throw new CertificateRefused(`${anchorName}: certificate ${i + 1} can't be parsed`, true);
      }
    })
    .concat(input.trust.system ? loadSystemRoots() : []);
  const last = certs.at(-1)!;
  // By fingerprint (the top is itself a configured anchor), else by issuer name and
  // signature (a CA rollover can leave two anchors with one name), else by name alone,
  // which the signature check below then refuses.
  const byName = anchors.filter((a) => last.checkIssued(a));
  const anchor =
    anchors.find((a) => a.fingerprint256 === last.fingerprint256) ??
    byName.find((a) => last.verify(a.publicKey)) ??
    byName[0];
  if (anchor && anchor.fingerprint256 !== last.fingerprint256 && !last.verify(anchor.publicKey)) {
    throw new CertificateRefused("the chain's signature by its certificate authority is invalid");
  }
  if (!anchor) {
    // A self-signed end is a root nobody configured; otherwise the issuer is missing.
    if (last.checkIssued(last)) degrade('degraded-untrusted', 'untrusted');
    else degrade('degraded-incomplete-chain', 'incomplete-chain');
  }

  // A client checks the dates of every certificate it is sent except a trusted
  // root, so the chain is valid only where all of them are. Reported as the
  // window rather than refused: validity is startup's and the reloader's call.
  const dated = certs.filter((cert) => cert.fingerprint256 !== anchor?.fingerprint256);
  const notBefore = Math.max(...dated.map((cert) => cert.validFromDate.getTime()));
  const notAfter = Math.min(...dated.map((cert) => cert.validToDate.getTime()));

  const missingNames = input.names.filter((name) =>
    isIP(name)
      ? leaf.checkIP(name) === undefined
      : leaf.checkHost(name, { subject: 'never' }) === undefined
  );
  if (missingNames.length > 0) degrade('degraded-san', 'san-missing');

  return {
    source: input.source,
    key: input.keyPem,
    cert: input.certPems.join(''),
    fingerprint: leaf.fingerprint256,
    contextFingerprint: createHash('sha256')
      .update(input.keyPem)
      .update('\0')
      .update(input.certPems.join(''))
      .digest('hex'),
    notBefore,
    notAfter,
    sans: parseSans(leaf.subjectAltName),
    class: chainClass,
    reasons,
    missingNames,
    // The anchor the chain actually verified against (a refused signature never gets here).
    ...(input.source === 'generated' && anchor ? { caFingerprint: anchor.fingerprint256 } : {})
  };
}

/** Puts the setting in front of a refusal that doesn't already name one. */
function named<T>(setting: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (error) {
    if (error instanceof CertificateRefused && !error.named) {
      throw new CertificateRefused(`${setting}: ${error.message}`, true);
    }
    throw error;
  }
}

/**
 * Reads and inspects the active source's files. Operator: the certificate
 * (+ chain) and key files, trusting PIPULSE_TLS_CA or else Node's bundled root certificates (not /etc/ssl/certs).
 * Generated: leaf.pem against ca.crt, with the strict file policy.
 */
export function loadCertificate(
  source: CertSource,
  options: { names: string[]; generatedOwner?: { uid?: number; gid?: number } }
): LoadedCertificate {
  if (source.kind === 'operator') {
    const certPems = parseCertificateFile(
      readSecureFile(source.certPath, { kind: 'operator', secret: false }, 'PIPULSE_TLS_CERT'),
      'PIPULSE_TLS_CERT'
    );
    const keyPem = parseKeyFile(
      readSecureFile(source.keyPath, { kind: 'operator', secret: true }, 'PIPULSE_TLS_KEY'),
      'PIPULSE_TLS_KEY'
    );
    const trust: Trust = source.caPath
      ? {
          anchors: parseCertificateFile(
            readSecureFile(source.caPath, { kind: 'operator', secret: false }, 'PIPULSE_TLS_CA'),
            'PIPULSE_TLS_CA'
          ),
          system: false
        }
      : { anchors: [], system: true };
    return named('PIPULSE_TLS_CERT/PIPULSE_TLS_KEY', () =>
      inspectMaterial({ source: 'operator', keyPem, certPems, trust, names: options.names })
    );
  }
  const owner = options.generatedOwner ?? {};
  const bundle = parseBundle(
    readSecureFile(source.bundlePath, { kind: 'generated', maxMode: 0o640, ...owner }, 'leaf.pem'),
    'leaf.pem'
  );
  const ca = parseCertificateFile(
    readSecureFile(source.caPath, { kind: 'generated', maxMode: 0o644, ...owner }, 'ca.crt'),
    'ca.crt'
  );
  return named(basename(source.bundlePath), () =>
    inspectMaterial({
      source: 'generated',
      keyPem: bundle.key,
      certPems: bundle.certs,
      trust: { anchors: ca, system: false },
      names: options.names
    })
  );
}
