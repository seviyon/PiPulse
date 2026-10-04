import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { checkServerIdentity, connect, createServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKDATE_MS,
  CA_LIFETIME_MS,
  IssueError,
  LEAF_LIFETIME_MS,
  caExtensions,
  issueCa,
  issueLeaf,
  leafExtensions,
  opensslConfig,
  parseOpensslVersion,
  type IssueScope,
  type Issued
} from '../src/issue.js';
import { tempDir } from './helpers.js';
import { TEST_OPENSSL } from './openssl.js';

const NOW = Date.now();
const DAY = 86_400_000;
// A stand-in for a Pi called "pipulse-check" whose operator accepted 192.168.77.0/24.
const SCOPE: IssueScope = {
  dns: ['pipulse-check', 'pipulse-check.local', 'localhost'],
  excludedDns: ['.pipulse-check', '.localhost'],
  ip: [
    { address: '127.0.0.1', prefix: 32 },
    { address: '::1', prefix: 128 },
    { address: '192.168.77.0', prefix: 24 }
  ]
};

let work: string;
let ca: Issued;
let caPaths: { keyPath: string; certPath: string; certPem: string };
beforeAll(async () => {
  work = tempDir();
  ca = await issueCa({
    openssl: TEST_OPENSSL,
    workDir: work,
    subject: 'PiPulse CA pipulse-check 0a1b2c',
    scope: SCOPE,
    now: NOW
  });
  writeFileSync(join(work, 'ca.key'), ca.keyPem, { mode: 0o600 });
  writeFileSync(join(work, 'ca.crt'), ca.certPem);
  caPaths = { keyPath: join(work, 'ca.key'), certPath: join(work, 'ca.crt'), certPem: ca.certPem };
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const leaf = (dns: string[], ip: string[] = []) =>
  issueLeaf({
    openssl: TEST_OPENSSL,
    workDir: work,
    ca: caPaths,
    subject: dns[0] ?? 'pipulse',
    dns,
    ip,
    now: NOW
  });

/** Serves `cert` and connects trusting only `caPem`, verifying `identity`. 'ok' or the error. */
async function handshake(cert: Issued, identity: string): Promise<string> {
  const server = createServer({ key: cert.keyPem, cert: cert.certPem }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string>((resolve) => {
      const socket = connect(
        {
          port,
          host: '127.0.0.1',
          ca: ca.certPem,
          ...(isIP(identity) ? {} : { servername: identity }),
          // tls.checkServerIdentity never matches an IPv6 literal (Node 22.23 and 24.19 run
          // it through domainToASCII, which returns ''), so IPs go through X509Certificate.
          checkServerIdentity: (_host, peer) =>
            isIP(identity)
              ? new X509Certificate(peer.raw).checkIP(identity)
                ? undefined
                : new Error(`IP ${identity} is not in the certificate`)
              : checkServerIdentity(identity, peer)
        },
        () => {
          socket.end();
          resolve('ok');
        }
      );
      socket.on('error', (error) =>
        resolve(`${(error as NodeJS.ErrnoException).code ?? ''}: ${error.message}`)
      );
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const text = (pem: string) =>
  execFileSync(TEST_OPENSSL, ['x509', '-noout', '-text'], { input: pem }).toString();

describe('parseOpensslVersion', () => {
  it('accepts OpenSSL 1.1.1 and 3.x, refuses LibreSSL and nonsense', () => {
    expect(parseOpensslVersion('OpenSSL 1.1.1w  11 Sep 2023')).toBe('1.1.1w');
    expect(parseOpensslVersion('OpenSSL 3.0.17 1 Jul 2025 (Library: OpenSSL 3.0.17)')).toBe(
      '3.0.17'
    );
    expect(() => parseOpensslVersion('LibreSSL 3.3.6')).toThrow(IssueError);
    expect(() => parseOpensslVersion('')).toThrow(/OpenSSL 1.1.1 or 3.x/);
  });
});

describe('the generated openssl config', () => {
  it.each([
    'bad name',
    'a,b',
    'a=b',
    'a\nb',
    '$HOME',
    'x'.repeat(64),
    'a..b',
    'UPPER',
    '-lead',
    '10.0.0.1'
  ])('refuses the DNS value %j', (name) => {
    expect(() => leafExtensions([name], [])).toThrow(IssueError);
    expect(() => caExtensions({ ...SCOPE, dns: [name] })).toThrow(IssueError);
  });

  it.each(['1.2.3', '::g', '1.2.3.4/8', '::ffff:1.2.3.4 '])('refuses the IP %j', (ip) => {
    expect(() => leafExtensions(['a'], [ip])).toThrow(IssueError);
  });

  it('refuses an excluded name without its leading dot, a bad prefix and a bad subject', () => {
    expect(() => caExtensions({ ...SCOPE, excludedDns: ['io'] })).toThrow(IssueError);
    expect(() => caExtensions({ ...SCOPE, ip: [{ address: '10.0.0.0', prefix: 33 }] })).toThrow(
      IssueError
    );
    expect(() => opensslConfig({ workDir: '/tmp/x', subject: 'a\nb', extensions: [] })).toThrow(
      IssueError
    );
    expect(() => opensslConfig({ workDir: '/tmp/$x', subject: 'a', extensions: [] })).toThrow(
      IssueError
    );
  });

  it('writes masks, never an IP exclusion', () => {
    const ext = caExtensions(SCOPE).join('\n');
    expect(ext).toContain('permitted;IP:192.168.77.0/255.255.255.0');
    expect(ext).toContain('permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    expect(ext).toContain('excluded;DNS:.pipulse-check');
    expect(ext).not.toMatch(/excluded;IP/);
  });
});

describe('issueCa', () => {
  it('makes a P-256 CA with pathlen 0, critical name constraints and a 10-year life', () => {
    const cert = new X509Certificate(ca.certPem);
    expect(cert.ca).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(ca.notBefore).toBeGreaterThanOrEqual(NOW - BACKDATE_MS - 2000);
    expect(ca.notBefore).toBeLessThanOrEqual(NOW - BACKDATE_MS + 2000);
    expect(Math.abs(ca.notAfter - (NOW + CA_LIFETIME_MS))).toBeLessThan(2000);
    const out = text(ca.certPem);
    expect(out).toMatch(/Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
    expect(out).toMatch(/Key Usage: critical\s+Certificate Sign, CRL Sign/);
    expect(out).toMatch(/Name Constraints: critical/);
    expect(out).not.toMatch(/Excluded:\s+IP/);
    expect(ca.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('never reuses a serial', async () => {
    const other = await issueCa({
      openssl: TEST_OPENSSL,
      workDir: work,
      subject: 'PiPulse CA pipulse-check 0a1b2c',
      scope: SCOPE,
      now: NOW
    });
    expect(new X509Certificate(other.certPem).serialNumber).not.toBe(
      new X509Certificate(ca.certPem).serialNumber
    );
  });
});

describe('issueLeaf', () => {
  it('makes a 90-day serverAuth leaf, backdated an hour, that verifies against the CA', async () => {
    const issued = await leaf(['pipulse-check', 'localhost'], ['127.0.0.1', '::1']);
    const cert = new X509Certificate(issued.certPem);
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect(cert.checkIssued(new X509Certificate(ca.certPem))).toBe(true);
    expect(Math.abs(issued.notBefore - (NOW - BACKDATE_MS))).toBeLessThan(2000);
    expect(Math.abs(issued.notAfter - (NOW + LEAF_LIFETIME_MS))).toBeLessThan(2000);
    expect(issued.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    // A file, not /dev/stdin: OpenSSL 1.1.1 can't open /dev/stdin in some containers.
    const leafFile = join(work, 'leaf-check.crt');
    writeFileSync(leafFile, issued.certPem);
    const verify = execFileSync(TEST_OPENSSL, [
      'verify',
      '-purpose',
      'sslserver',
      '-CAfile',
      caPaths.certPath,
      leafFile
    ]).toString();
    expect(verify).toMatch(/OK/);
  });

  it('never outlives the CA', async () => {
    const issued = await issueLeaf({
      openssl: TEST_OPENSSL,
      workDir: work,
      ca: caPaths,
      subject: 'pipulse-check',
      dns: ['pipulse-check'],
      ip: [],
      now: NOW + CA_LIFETIME_MS - 10 * DAY
    });
    expect(issued.notAfter).toBeLessThanOrEqual(ca.notAfter);
  });

  it('refuses to issue from an expired CA', async () => {
    await expect(
      issueLeaf({
        openssl: TEST_OPENSSL,
        workDir: work,
        ca: caPaths,
        subject: 'pipulse-check',
        dns: ['pipulse-check'],
        ip: [],
        now: NOW + CA_LIFETIME_MS + DAY
      })
    ).rejects.toThrow(/CA has expired/);
  });
});

// The exit test: Node (OpenSSL underneath) enforces the constraints both ways.
describe('the handshake matrix', () => {
  it.each([
    [['pipulse-check'], [], 'pipulse-check'],
    [['pipulse-check.local'], [], 'pipulse-check.local'],
    [['localhost'], ['127.0.0.1', '::1'], 'localhost'],
    [['localhost'], ['127.0.0.1'], '127.0.0.1'],
    [['localhost'], ['::1'], '::1'],
    [['pipulse-check'], ['192.168.77.5'], '192.168.77.5']
  ])('allows %j %j for %s', async (dns, ip, identity) => {
    expect(await handshake(await leaf(dns, ip), identity)).toBe('ok');
  });

  it.each([
    [['other-check.lan'], [], 'other-check.lan', /permitted subtree violation/],
    [['x.pipulse-check'], [], 'x.pipulse-check', /excluded subtree violation/],
    [['pipulse-check'], ['10.0.0.9'], '10.0.0.9', /permitted subtree violation/],
    [['pipulse-check'], ['192.168.78.5'], '192.168.78.5', /permitted subtree violation/]
  ])('refuses %j %j for %s', async (dns, ip, identity, error) => {
    expect(await handshake(await leaf(dns, ip), identity)).toMatch(error);
  });
});
