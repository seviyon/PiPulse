import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export class IssueError extends Error {
  override name = 'IssueError';
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The OpenSSL root runs: a fixed path, never looked up on PATH. */
export const OPENSSL = '/usr/bin/openssl';
export const CA_LIFETIME_MS = 3650 * DAY_MS;
export const LEAF_LIFETIME_MS = 90 * DAY_MS;
/** Certificates start an hour early: client clocks drift, and a Pi has no RTC. */
export const BACKDATE_MS = HOUR_MS;
const TIMEOUT_MS = 30_000;

/** An IP range in a name constraint: a canonical network address and a prefix length. */
export interface IpRange {
  address: string;
  prefix: number;
}

/**
 * What a CA may issue for (critical nameConstraints). Values are canonical
 * already (constraints.ts makes them); this module re-checks their syntax
 * before any of them reaches an openssl config.
 */
export interface IssueScope {
  /** Permitted DNS names; RFC 5280 also permits every name below each one. */
  dns: string[];
  /** Excluded DNS subtrees, each starting with "." (".io": below io, not io itself). */
  excludedDns: string[];
  /** Permitted IP ranges. No IP exclusions are ever written: an exclusion beats every permit. */
  ip: IpRange[];
}

export interface Issued {
  keyPem: string;
  certPem: string;
  /** SHA-256, colon-separated hex (X509Certificate.fingerprint256). */
  fingerprint: string;
  notBefore: number;
  notAfter: number;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/;
const SAFE_PATH = /^[A-Za-z0-9/._-]+$/;
const quoted = (value: string) => JSON.stringify(value.slice(0, 80));

function dnsName(name: string): string {
  if (!DNS_NAME.test(name) || isIP(name) !== 0) {
    throw new IssueError(`not a canonical DNS name: ${quoted(name)}`);
  }
  return name;
}

function ipAddress(address: string): string {
  if (!/^[0-9a-f.:]+$/.test(address) || isIP(address) === 0) {
    throw new IssueError(`not a canonical IP address: ${quoted(address)}`);
  }
  return address;
}

/** An address as 16-bit words: two for IPv4, eight for IPv6 (any "::" or dotted tail expanded). */
function words(address: string, family: 4 | 6): number[] {
  const dotted = (text: string) => {
    const [a, b, c, d] = text.split('.').map(Number) as [number, number, number, number];
    return [(a << 8) | b, (c << 8) | d];
  };
  if (family === 4) return dotted(address);
  const tail = address.includes('.') ? address.slice(address.lastIndexOf(':') + 1) : undefined;
  const head =
    tail === undefined ? address : `${address.slice(0, address.lastIndexOf(':') + 1)}0:0`;
  const [left = '', right] = head.split('::');
  const part = (text: string) => (text === '' ? [] : text.split(':').map((g) => parseInt(g, 16)));
  const front = part(left);
  const back = right === undefined ? [] : part(right);
  const all =
    right === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
  if (tail !== undefined) all.splice(6, 2, ...dotted(tail));
  return all;
}

/**
 * The netmask openssl wants after the slash (it doesn't take prefix lengths).
 * Refuses /0 (it would permit every address) and an address with bits set
 * beyond the prefix (192.168.77.5/24): a constraint is always a network.
 */
function netmask(range: IpRange): string {
  const family = isIP(ipAddress(range.address)) as 4 | 6;
  const bits = family === 4 ? 32 : 128;
  if (!Number.isInteger(range.prefix) || range.prefix < 1 || range.prefix > bits) {
    throw new IssueError(`bad prefix length /${range.prefix}`);
  }
  const mask: number[] = [];
  for (let g = 0; g < bits / 16; g++) {
    const on = Math.max(0, Math.min(16, range.prefix - g * 16));
    mask.push(on === 0 ? 0 : (0xffff << (16 - on)) & 0xffff);
  }
  if (words(range.address, family).some((word, g) => (word & ~mask[g]!) !== 0)) {
    throw new IssueError(`${range.address}/${range.prefix} has bits set beyond the prefix`);
  }
  if (family === 4) return mask.flatMap((w) => [w >> 8, w & 255]).join('.');
  return mask.map((w) => w.toString(16)).join(':');
}

export function caExtensions(scope: IssueScope, keyIds = true): string[] {
  if (scope.dns.length === 0 || scope.ip.length === 0) {
    throw new IssueError('a CA needs at least one permitted DNS name and one IP range');
  }
  const permitted = [
    ...scope.dns.map((name) => `permitted;DNS:${dnsName(name)}`),
    ...scope.ip.map((range) => `permitted;IP:${range.address}/${netmask(range)}`)
  ];
  const excluded = scope.excludedDns.map((name) => {
    if (!name.startsWith('.'))
      throw new IssueError(`an excluded name must start with ".": ${quoted(name)}`);
    return `excluded;DNS:.${dnsName(name.slice(1))}`;
  });
  return [
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    ...(keyIds ? ['subjectKeyIdentifier = hash'] : []),
    `nameConstraints = critical, ${[...permitted, ...excluded].join(', ')}`
  ];
}

export function leafExtensions(dns: string[], ip: string[], keyIds = true): string[] {
  const sans = [
    ...dns.map((name) => `DNS:${dnsName(name)}`),
    ...ip.map((a) => `IP:${ipAddress(a)}`)
  ];
  if (sans.length === 0) throw new IssueError('a certificate needs at least one name');
  return [
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature',
    'extendedKeyUsage = serverAuth',
    ...(keyIds ? ['subjectKeyIdentifier = hash', 'authorityKeyIdentifier = keyid'] : []),
    `subjectAltName = ${sans.join(', ')}`
  ];
}

/**
 * The whole config for one `openssl req` + `openssl ca` run. `copy_extensions
 * = none`: nothing from the request is ever copied into a certificate.
 */
export function opensslConfig(options: {
  workDir: string;
  subject: string;
  extensions: string[];
}): string {
  if (!SAFE_PATH.test(options.workDir))
    throw new IssueError('the work directory path has unexpected characters');
  if (!SUBJECT.test(options.subject))
    throw new IssueError(`subject has unexpected characters: ${quoted(options.subject)}`);
  return [
    '[ca]',
    'default_ca = pipulse',
    '[pipulse]',
    `database = ${options.workDir}/index.txt`,
    `new_certs_dir = ${options.workDir}`,
    `serial = ${options.workDir}/serial`,
    'default_md = sha256',
    'policy = any',
    'unique_subject = no',
    'copy_extensions = none',
    'email_in_dn = no',
    '[any]',
    'organizationName = optional',
    'commonName = supplied',
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    'O = PiPulse',
    `CN = ${options.subject}`,
    '[ext]',
    ...options.extensions,
    ''
  ].join('\n');
}

export function parseOpensslVersion(text: string): string {
  const match = /^OpenSSL (1\.1\.1\S*|3\.\d+\.\d+\S*)/.exec(text.trim());
  if (!match) {
    throw new IssueError(
      `PiPulse needs OpenSSL 1.1.1 or 3.x (sudo apt install openssl), found: ${text.trim().slice(0, 60) || 'nothing'}`
    );
  }
  return match[1]!;
}

function run(openssl: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      openssl,
      args,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 1 << 20, env: { PATH: '/usr/bin:/bin' } },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT')
          return reject(new IssueError(`${openssl} not found: sudo apt install openssl`));
        const detail =
          String(stderr)
            .split('\n')
            .find((line) => line.trim() !== '') ?? error.message;
        reject(new IssueError(`openssl ${args[0]} failed: ${detail.slice(0, 200)}`));
      }
    );
  });
}

export async function opensslVersion(openssl = OPENSSL): Promise<string> {
  return parseOpensslVersion(await run(openssl, ['version'], '/'));
}

/** An ECDSA P-256 key as PKCS#8 PEM ("PRIVATE KEY"), the only form leaf.pem accepts. */
export function newKey(): string {
  return generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  }).privateKey;
}

/** 20260930123456Z: the form `openssl ca -startdate/-enddate` takes. */
const asn1Time = (ms: number) =>
  `${new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

async function sign(options: {
  openssl: string;
  workDir: string;
  subject: string;
  extensions: string[];
  keyPem: string;
  issuer?: { keyPath: string; certPath: string };
  notBefore: number;
  notAfter: number;
}): Promise<string> {
  // A private scratch folder per run (the caller's workDir is root 0700); the
  // key written here is deleted in `finally`, whatever happens.
  const dir = mkdtempSync(join(options.workDir, 'issue-'));
  try {
    const file = (name: string, content: string) => {
      writeFileSync(join(dir, name), content, { mode: 0o600, flag: 'wx' });
      return join(dir, name);
    };
    const conf = file(
      'openssl.cnf',
      opensslConfig({ workDir: dir, subject: options.subject, extensions: options.extensions })
    );
    const key = file('key.pem', options.keyPem);
    file('index.txt', '');
    const serial = randomBytes(16);
    serial[0] = (serial[0]! & 0x7f) | 0x40; // positive, and always 16 bytes long
    file('serial', `${serial.toString('hex').toUpperCase()}\n`);
    const csr = join(dir, 'request.csr');
    const crt = join(dir, 'cert.pem');
    await run(options.openssl, ['req', '-new', '-config', conf, '-key', key, '-out', csr], dir);
    const signer = options.issuer
      ? ['-cert', options.issuer.certPath, '-keyfile', options.issuer.keyPath]
      : ['-selfsign', '-keyfile', key];
    await run(
      options.openssl,
      [
        'ca',
        '-batch',
        '-config',
        conf,
        ...signer,
        '-extensions',
        'ext',
        '-startdate',
        asn1Time(options.notBefore),
        '-enddate',
        asn1Time(options.notAfter),
        '-in',
        csr,
        '-out',
        crt,
        '-notext'
      ],
      dir
    );
    return new X509Certificate(readFileSync(crt, 'utf8')).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function described(keyPem: string, certPem: string): Issued {
  const cert = new X509Certificate(certPem);
  return {
    keyPem,
    certPem,
    fingerprint: cert.fingerprint256,
    notBefore: cert.validFromDate.getTime(),
    notAfter: cert.validToDate.getTime()
  };
}

export async function issueCa(options: {
  openssl?: string;
  workDir: string;
  subject: string;
  scope: IssueScope;
  now: number;
  /** Tests only: leave out the key identifiers (default true). */
  keyIds?: boolean;
}): Promise<Issued> {
  const keyPem = newKey();
  const certPem = await sign({
    openssl: options.openssl ?? OPENSSL,
    workDir: options.workDir,
    subject: options.subject,
    extensions: caExtensions(options.scope, options.keyIds ?? true),
    keyPem,
    notBefore: options.now - BACKDATE_MS,
    notAfter: options.now + CA_LIFETIME_MS
  });
  return described(keyPem, certPem);
}

export function verifyIssued(leafPem: string, caPem: string): void {
  const leaf = new X509Certificate(leafPem);
  const ca = new X509Certificate(caPem);
  if (leaf.ca) throw new IssueError('the new certificate is a CA certificate');
  if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) {
    throw new IssueError('the new certificate does not verify against the CA');
  }
}

/**
 * A leaf signed by the CA whose key and certificate are at `ca`. Names are
 * only syntax-checked here: which ones belong in a leaf is leafNames()'s
 * call (constraints.ts). Never outlives the CA; refuses an expired CA.
 */
export async function issueLeaf(options: {
  openssl?: string;
  workDir: string;
  ca: { keyPath: string; certPath: string; certPem: string };
  subject: string;
  dns: string[];
  ip: string[];
  now: number;
  lifetimeMs?: number;
  keyIds?: boolean;
}): Promise<Issued> {
  const lifetime = options.lifetimeMs ?? LEAF_LIFETIME_MS;
  if (!Number.isFinite(lifetime) || lifetime <= 0) throw new IssueError('bad certificate lifetime');
  const ca = new X509Certificate(options.ca.certPem);
  const notAfter = Math.min(options.now + lifetime, ca.validToDate.getTime());
  const notBefore = Math.max(options.now - BACKDATE_MS, ca.validFromDate.getTime());
  if (notAfter <= options.now)
    throw new IssueError('the CA has expired: make a new one with sudo pipulse tls new-ca');
  const keyPem = newKey();
  const certPem = await sign({
    openssl: options.openssl ?? OPENSSL,
    workDir: options.workDir,
    subject: options.subject,
    extensions: leafExtensions(options.dns, options.ip, options.keyIds ?? true),
    keyPem,
    issuer: { keyPath: options.ca.keyPath, certPath: options.ca.certPath },
    notBefore,
    notAfter
  });
  verifyIssued(certPem, options.ca.certPem);
  return described(keyPem, certPem);
}
