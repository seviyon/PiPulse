import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKDATE_MS,
  CA_LIFETIME_MS,
  IssueError,
  LEAF_LIFETIME_MS,
  OPENSSL,
  caExtensions,
  issueCa,
  issueLeaf,
  leafExtensions,
  newKey,
  opensslConfig,
  opensslVersion,
  parseOpensslVersion,
  verifyIssued,
  type IssueScope,
  type Issued
} from '../../src/ca/issue.js';
import { tempDir } from '../helpers.js';
import { TEST_OPENSSL } from '../openssl.js';

const NOW = Date.UTC(2026, 9, 13, 12, 34, 56, 789);
const HOUR = 3_600_000;
const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
const SCOPE: IssueScope = {
  dns: ['pipulse-check', 'pipulse-check.local', 'localhost'],
  excludedDns: ['.pipulse-check', '.localhost'],
  ip: [
    { address: '127.0.0.1', prefix: 32 },
    { address: '::1', prefix: 128 },
    { address: '192.168.77.0', prefix: 24 }
  ]
};
const text = (pem: string) =>
  execFileSync(TEST_OPENSSL, ['x509', '-noout', '-text'], { input: pem }).toString();

// A wrapper that records how it was called (argv, environment, cwd, and for `ca` the
// scratch folder's serial/index/modes) and then runs the real OpenSSL.
interface Call {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  serial?: string;
  index?: string;
  ls?: string;
  cnf?: string;
}
let root: string;
let logDir: string;
let wrapper: string;

function resetLog(): void {
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir);
}
function calls(command: string): Call[] {
  const names = readdirSync(logDir).filter(
    (n) => n.startsWith(`${command}-`) && n.endsWith('.args')
  );
  return names.map((name) => {
    const stem = join(logDir, name.slice(0, -'.args'.length));
    const read = (ext: string) =>
      existsSync(stem + ext) ? readFileSync(stem + ext, 'utf8') : undefined;
    const env: Record<string, string> = {};
    for (const line of (read('.env') ?? '').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return {
      args: (read('.args') ?? '').split('\n').slice(0, -1),
      env,
      cwd: (read('.cwd') ?? '').trim(),
      serial: read('.serial'),
      index: read('.index'),
      ls: read('.ls'),
      cnf: read('.cnf')
    };
  });
}

let work: string;
let ca: Issued;
let caRun: { req: Call; ca: Call };
let caPaths: { keyPath: string; certPath: string; certPem: string };
let leafIssued: Issued;
let leafRun: { req: Call; ca: Call };
let plainCa: Issued;
let plainLeaf: Issued;

beforeAll(async () => {
  process.env['PIPULSE_LEAK_CANARY'] = 'leaked';
  root = tempDir();
  logDir = join(root, 'log');
  wrapper = join(root, 'openssl-wrapper');
  writeFileSync(
    wrapper,
    `#!/bin/sh
L='${logDir}'
f="$L/$1-$$"
for a in "$@"; do printf '%s\\n' "$a" >> "$f.args"; done
[ -e "$f.args" ] || : > "$f.args"
/usr/bin/env > "$f.env"
pwd -P > "$f.cwd"
if [ "$1" = ca ]; then
  /bin/cat serial > "$f.serial"
  /bin/cat index.txt > "$f.index"
  /bin/cat openssl.cnf > "$f.cnf"
  /bin/ls -l index.txt key.pem openssl.cnf serial > "$f.ls" 2>&1
  /bin/ls -ld . >> "$f.ls" 2>&1
fi
if [ -e "$L/fail-$1" ]; then echo "  unit failure here" >&2; exit 1; fi
exec '${TEST_OPENSSL}' "$@"
`
  );
  chmodSync(wrapper, 0o755);
  work = join(root, 'work');
  mkdirSync(work);

  resetLog();
  ca = await issueCa({
    openssl: wrapper,
    workDir: work,
    subject: 'PiPulse CA pipulse-check 0a1b2c',
    scope: SCOPE,
    now: NOW
  });
  caRun = { req: calls('req')[0]!, ca: calls('ca')[0]! };
  expect(calls('req')).toHaveLength(1);
  expect(calls('ca')).toHaveLength(1);
  writeFileSync(join(work, 'ca.key'), ca.keyPem, { mode: 0o600 });
  writeFileSync(join(work, 'ca.crt'), ca.certPem);
  caPaths = { keyPath: join(work, 'ca.key'), certPath: join(work, 'ca.crt'), certPem: ca.certPem };

  resetLog();
  leafIssued = await issueLeaf({
    openssl: wrapper,
    workDir: work,
    ca: caPaths,
    subject: 'pipulse-check',
    dns: ['pipulse-check', 'localhost'],
    ip: ['127.0.0.1', '::1'],
    now: NOW
  });
  leafRun = { req: calls('req')[0]!, ca: calls('ca')[0]! };

  plainCa = await issueCa({
    openssl: TEST_OPENSSL,
    workDir: work,
    subject: 'PiPulse CA pipulse-check 0a1b2c',
    scope: SCOPE,
    now: NOW,
    keyIds: false
  });
  writeFileSync(join(work, 'plain-ca.key'), plainCa.keyPem, { mode: 0o600 });
  writeFileSync(join(work, 'plain-ca.crt'), plainCa.certPem);
  plainLeaf = await issueLeaf({
    openssl: TEST_OPENSSL,
    workDir: work,
    ca: {
      keyPath: join(work, 'plain-ca.key'),
      certPath: join(work, 'plain-ca.crt'),
      certPem: plainCa.certPem
    },
    subject: 'pipulse-check',
    dns: ['pipulse-check'],
    ip: [],
    now: NOW,
    keyIds: false
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('constants and errors', () => {
  it('pins the openssl path, lifetimes and the error name', () => {
    expect(OPENSSL).toBe('/usr/bin/openssl');
    expect(BACKDATE_MS).toBe(HOUR);
    expect(CA_LIFETIME_MS).toBe(3650 * 24 * HOUR);
    expect(LEAF_LIFETIME_MS).toBe(90 * 24 * HOUR);
    expect(new IssueError('x').name).toBe('IssueError');
  });
});

describe('error messages tell the operator what is wrong', () => {
  it('quotes at most 80 characters of a bad name', () => {
    const long = 'A'.repeat(100);
    expect(() => leafExtensions([long], [])).toThrow(
      new IssueError(`not a canonical DNS name: ${JSON.stringify('A'.repeat(80))}`)
    );
    expect(() => leafExtensions([], [long])).toThrow(
      new IssueError(`not a canonical IP address: ${JSON.stringify('A'.repeat(80))}`)
    );
    expect(() => caExtensions({ ...SCOPE, excludedDns: [long] })).toThrow(
      new IssueError(`an excluded name must start with ".": ${JSON.stringify('A'.repeat(80))}`)
    );
    expect(() => opensslConfig({ workDir: '/tmp/x', subject: long, extensions: [] })).toThrow(
      new IssueError(`subject has unexpected characters: ${JSON.stringify('A'.repeat(80))}`)
    );
  });

  it('anchors the IP syntax at both ends', () => {
    // Upper case after a lower-case start, and lower case after an upper-case start.
    expect(() => leafExtensions([], ['fe80::A'])).toThrow(/not a canonical IP address/);
    expect(() => leafExtensions([], ['FE80::1'])).toThrow(/not a canonical IP address/);
    expect(leafExtensions([], ['fe80::1']).join('\n')).toContain('IP:fe80::1');
  });

  it('names the problem for every refusal', () => {
    expect(() => caExtensions({ ...SCOPE, dns: [] })).toThrow(
      new IssueError('a CA needs at least one permitted DNS name and one IP range')
    );
    expect(() => caExtensions({ ...SCOPE, ip: [] })).toThrow(
      new IssueError('a CA needs at least one permitted DNS name and one IP range')
    );
    expect(() => caExtensions({ ...SCOPE, excludedDns: ['io'] })).toThrow(
      new IssueError('an excluded name must start with ".": "io"')
    );
    expect(() => leafExtensions([], [])).toThrow(
      new IssueError('a certificate needs at least one name')
    );
    expect(() => opensslConfig({ workDir: '/tmp/$x', subject: 'a', extensions: [] })).toThrow(
      new IssueError('the work directory path has unexpected characters')
    );
    const range = (address: string, prefix: number) => ({ ...SCOPE, ip: [{ address, prefix }] });
    expect(() => caExtensions(range('10.0.0.0', 0))).toThrow(
      new IssueError('bad prefix length /0')
    );
    expect(() => caExtensions(range('10.0.0.0', 33))).toThrow(
      new IssueError('bad prefix length /33')
    );
    expect(() => caExtensions(range('fd00::', 129))).toThrow(
      new IssueError('bad prefix length /129')
    );
    expect(() => caExtensions(range('10.0.0.0', 8.5))).toThrow(
      new IssueError('bad prefix length /8.5')
    );
    expect(() => caExtensions(range('192.168.77.5', 24))).toThrow(
      new IssueError('192.168.77.5/24 has bits set beyond the prefix')
    );
  });

  it('accepts a /1 and a /32', () => {
    const ext = caExtensions({
      ...SCOPE,
      ip: [
        { address: '128.0.0.0', prefix: 1 },
        { address: '10.1.2.3', prefix: 32 }
      ]
    }).join('\n');
    expect(ext).toContain('permitted;IP:128.0.0.0/128.0.0.0');
    expect(ext).toContain('permitted;IP:10.1.2.3/255.255.255.255');
  });
});

describe('IPv6 ranges are read word by word', () => {
  it.each([
    ['fd00::', 64, 'ffff:ffff:ffff:ffff:0:0:0:0'],
    ['2001:db8::', 32, 'ffff:ffff:0:0:0:0:0:0'],
    ['2001:db8:1:2::', 64, 'ffff:ffff:ffff:ffff:0:0:0:0'],
    ['fd00:0:0:1::', 64, 'ffff:ffff:ffff:ffff:0:0:0:0'],
    ['1::', 16, 'ffff:0:0:0:0:0:0:0'],
    ['::', 128, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['fd00:1:2:3:4:5:6:0', 112, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:0'],
    ['fd00:1:2:3:4:5:6:7', 128, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:db8::1', 128, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:db8:1::2', 128, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['::ffff:10.1.2.0', 119, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:fe00'],
    ['::10.1.2.0', 120, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ff00'],
    ['::ffff:10.1.2.3', 128, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']
  ])('accepts %s/%i', (address, prefix, mask) => {
    const ext = caExtensions({ ...SCOPE, ip: [{ address, prefix }] }).join('\n');
    expect(ext).toContain(`permitted;IP:${address}/${mask}`);
  });

  it.each([
    ['::1', 127],
    ['::ffff:10.1.2.3', 120],
    ['::ffff:10.1.3.0', 119],
    ['::10.1.2.1', 120],
    ['2001:db8:1:2::5', 64],
    ['2001:db8:1:2::5', 112],
    ['fd00:1:2:3:4:5:6:7', 112],
    ['fd00:1:2:3:4:5:6:7', 120],
    ['1::', 15],
    ['::ffff:10.0.0.0', 97],
    ['::ffff:10.0.0.0', 80],
    ['::ffff:0.0.0.0', 64],
    ['fd00::1', 64],
    ['2001:db8::1:0', 96]
  ])('refuses %s/%i (host bits set)', (address, prefix) => {
    expect(() => caExtensions({ ...SCOPE, ip: [{ address, prefix }] })).toThrow(
      new IssueError(`${address}/${prefix} has bits set beyond the prefix`)
    );
  });
});

describe('extension lists', () => {
  it('writes the CA extensions exactly', () => {
    expect(caExtensions(SCOPE, true)).toEqual([
      'basicConstraints = critical, CA:TRUE, pathlen:0',
      'keyUsage = critical, keyCertSign, cRLSign',
      'subjectKeyIdentifier = hash',
      'nameConstraints = critical, permitted;DNS:pipulse-check, permitted;DNS:pipulse-check.local, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255, permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff, permitted;IP:192.168.77.0/255.255.255.0, excluded;DNS:.pipulse-check, excluded;DNS:.localhost'
    ]);
    expect(caExtensions(SCOPE)).toEqual(caExtensions(SCOPE, true));
    expect(caExtensions(SCOPE, false)).toHaveLength(3);
    expect(caExtensions(SCOPE, false).join('\n')).not.toContain('subjectKeyIdentifier');
  });

  it('writes the leaf extensions exactly', () => {
    expect(leafExtensions(['a', 'b.c'], ['10.0.0.1', '::1'], true)).toEqual([
      'basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = serverAuth',
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid',
      'subjectAltName = DNS:a, DNS:b.c, IP:10.0.0.1, IP:::1'
    ]);
    expect(leafExtensions(['a'], [])).toEqual(leafExtensions(['a'], [], true));
    expect(leafExtensions(['a'], [], false)).toEqual([
      'basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = DNS:a'
    ]);
  });

  it('writes the openssl config exactly', () => {
    expect(opensslConfig({ workDir: '/w', subject: 'Some CA 1.2', extensions: ['x = y'] })).toBe(
      [
        '[ca]',
        'default_ca = pipulse',
        '[pipulse]',
        'database = /w/index.txt',
        'new_certs_dir = /w',
        'serial = /w/serial',
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
        'CN = Some CA 1.2',
        '[ext]',
        'x = y',
        ''
      ].join('\n')
    );
  });
});

describe('parseOpensslVersion', () => {
  it('reads the whole version token and nothing before it', () => {
    expect(parseOpensslVersion('OpenSSL 1.1.1')).toBe('1.1.1');
    expect(parseOpensslVersion('OpenSSL 1.1.1wx  11 Sep')).toBe('1.1.1wx');
    expect(parseOpensslVersion('OpenSSL 3.0.1')).toBe('3.0.1');
    expect(parseOpensslVersion('OpenSSL 3.10.22-dev')).toBe('3.10.22-dev');
    expect(parseOpensslVersion('\n  OpenSSL 3.0.17 1 Jul\n')).toBe('3.0.17');
    expect(() => parseOpensslVersion('xOpenSSL 3.0.1')).toThrow(IssueError);
    expect(() => parseOpensslVersion('Not OpenSSL 3.0.1')).toThrow(IssueError);
    expect(() => parseOpensslVersion('OpenSSL 1.1.0')).toThrow(IssueError);
    expect(() => parseOpensslVersion('OpenSSL 3.0')).toThrow(IssueError);
  });

  it('says what it found, trimmed and cut at 60 characters', () => {
    const prefix = 'PiPulse needs OpenSSL 1.1.1 or 3.x (sudo apt install openssl), found: ';
    expect(() => parseOpensslVersion('')).toThrow(new IssueError(`${prefix}nothing`));
    expect(() => parseOpensslVersion('  \n ')).toThrow(new IssueError(`${prefix}nothing`));
    expect(() => parseOpensslVersion('  LibreSSL 3.3.6\n')).toThrow(
      new IssueError(`${prefix}LibreSSL 3.3.6`)
    );
    expect(() => parseOpensslVersion(`  ${'z'.repeat(100)}`)).toThrow(
      new IssueError(`${prefix}${'z'.repeat(60)}`)
    );
  });
});

describe('running openssl', () => {
  it('asks for the version with the single argument "version", from /', async () => {
    resetLog();
    const version = await opensslVersion(wrapper);
    expect(version).toMatch(/^3\.\d+\.\d+|^1\.1\.1/);
    const [call] = calls('version');
    expect(call!.args).toEqual(['version']);
    expect(call!.cwd).toBe('/');
  });

  it('says where to install openssl when the program is missing', async () => {
    await expect(opensslVersion('/nonexistent/dir/openssl')).rejects.toThrow(
      new IssueError('/nonexistent/dir/openssl not found: sudo apt install openssl')
    );
  });

  it('reports the first non-blank stderr line, cut at 200 characters', async () => {
    const fail = join(root, 'fail.sh');
    writeFileSync(fail, `#!/bin/sh\nprintf '\\n  \\n  boom here\\nsecond line\\n' >&2\nexit 3\n`);
    chmodSync(fail, 0o755);
    await expect(opensslVersion(fail)).rejects.toThrow(
      new IssueError('openssl version failed:   boom here')
    );
    const long = join(root, 'long.sh');
    writeFileSync(long, `#!/bin/sh\nprintf '${'x'.repeat(300)}\\n' >&2\nexit 1\n`);
    chmodSync(long, 0o755);
    await expect(opensslVersion(long)).rejects.toThrow(
      new IssueError(`openssl version failed: ${'x'.repeat(200)}`)
    );
  });

  it('falls back to the error message when stderr is empty', async () => {
    const quiet = join(root, 'quiet.sh');
    writeFileSync(quiet, `#!/bin/sh\nexit 1\n`);
    chmodSync(quiet, 0o755);
    await expect(opensslVersion(quiet)).rejects.toThrow(/^openssl version failed: Command failed/);
  });
});

describe('what issueCa runs and writes', () => {
  const issueDir = (call: Call) => dirname(call.args[3]!);

  it('runs req then ca with a fixed argv inside a private scratch folder', () => {
    const dir = issueDir(caRun.req);
    expect(basename(dir)).toMatch(/^issue-/);
    expect(dirname(dir)).toBe(work);
    expect(basename(caRun.req.cwd)).toBe(basename(dir));
    expect(caRun.req.args).toEqual([
      'req',
      '-new',
      '-config',
      `${dir}/openssl.cnf`,
      '-key',
      `${dir}/key.pem`,
      '-out',
      `${dir}/request.csr`
    ]);
    expect(issueDir(caRun.ca)).toBe(dir);
    expect(basename(caRun.ca.cwd)).toBe(basename(dir));
    expect(caRun.ca.args).toEqual([
      'ca',
      '-batch',
      '-config',
      `${dir}/openssl.cnf`,
      '-selfsign',
      '-keyfile',
      `${dir}/key.pem`,
      '-extensions',
      'ext',
      '-startdate',
      '20261013113456Z',
      '-enddate',
      '20361010123456Z',
      '-in',
      `${dir}/request.csr`,
      '-out',
      `${dir}/cert.pem`,
      '-notext'
    ]);
  });

  it('signs a leaf with the CA files and the leaf dates', () => {
    const dir = issueDir(leafRun.ca);
    expect(leafRun.ca.args).toEqual([
      'ca',
      '-batch',
      '-config',
      `${dir}/openssl.cnf`,
      '-cert',
      caPaths.certPath,
      '-keyfile',
      caPaths.keyPath,
      '-extensions',
      'ext',
      '-startdate',
      '20261013113456Z',
      '-enddate',
      '20270111123456Z',
      '-in',
      `${dir}/request.csr`,
      '-out',
      `${dir}/cert.pem`,
      '-notext'
    ]);
  });

  it('runs openssl with PATH only, nothing from the caller environment', () => {
    for (const call of [caRun.req, caRun.ca, leafRun.req, leafRun.ca]) {
      const names = Object.keys(call.env).filter(
        (n) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n)
      );
      expect(names).toEqual(['PATH']);
      expect(call.env['PATH']).toBe('/usr/bin:/bin');
      expect(call.env['PIPULSE_LEAK_CANARY']).toBeUndefined();
    }
  });

  it('gives the serial 16 random bytes, positive, in upper case, and uses it', () => {
    for (const run of [caRun, leafRun]) {
      expect(run.ca.serial).toMatch(/^[4-7][0-9A-F]{31}\n$/);
    }
    expect(BigInt(`0x${caRun.ca.serial!.trim()}`).toString(16).toUpperCase()).toBe(
      new X509Certificate(ca.certPem).serialNumber.replace(/^0+/, '')
    );
    expect(BigInt(`0x${leafRun.ca.serial!.trim()}`).toString(16).toUpperCase()).toBe(
      new X509Certificate(leafIssued.certPem).serialNumber.replace(/^0+/, '')
    );
    expect(caRun.ca.serial).not.toBe(leafRun.ca.serial);
  });

  it('starts from an empty index and keeps scratch files private', () => {
    expect(caRun.ca.index).toBe('');
    const lines = caRun.ca.ls!.trim().split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines.slice(0, 4)) expect(line).toMatch(/^-rw-------/);
    expect(lines[4]).toMatch(/^drwx------/);
  });

  it('removes the scratch folder after success', () => {
    expect(readdirSync(work).filter((n) => n.startsWith('issue-'))).toEqual([]);
  });

  it('removes the scratch folder, key included, after a failure, and says which step failed', async () => {
    resetLog();
    writeFileSync(join(logDir, 'fail-ca'), '');
    const failWork = join(root, 'fail-work');
    mkdirSync(failWork);
    await expect(
      issueCa({
        openssl: wrapper,
        workDir: failWork,
        subject: 'PiPulse CA x',
        scope: SCOPE,
        now: NOW
      })
    ).rejects.toThrow(new IssueError('openssl ca failed:   unit failure here'));
    expect(readdirSync(failWork)).toEqual([]);
    rmSync(join(logDir, 'fail-ca'));
  });
});

describe('what the certificates contain', () => {
  it('gives the CA exactly 10 years from an hour before now', () => {
    expect(ca.notBefore).toBe(sec(NOW - HOUR));
    expect(ca.notAfter).toBe(sec(NOW + CA_LIFETIME_MS));
    expect(new X509Certificate(ca.certPem).fingerprint256).toBe(ca.fingerprint);
    const cert = new X509Certificate(ca.certPem);
    expect(cert.subject).toBe('O=PiPulse\nCN=PiPulse CA pipulse-check 0a1b2c');
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it('writes CA key usage, identifiers and name constraints into the certificate', () => {
    const out = text(ca.certPem);
    expect(out).toMatch(/Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
    expect(out).toMatch(/Key Usage: critical\s+Certificate Sign, CRL Sign/);
    expect(out).toMatch(/Subject Key Identifier/);
    expect(out).toMatch(/Name Constraints: critical/);
    expect(out).toMatch(/Permitted:[\s\S]*DNS:pipulse-check\b[\s\S]*DNS:localhost/);
    expect(out).toContain('IP:192.168.77.0/255.255.255.0');
    expect(out).toContain('IP:127.0.0.1/255.255.255.255');
    expect(out).toMatch(/Excluded:\s+DNS:\.pipulse-check\s+DNS:\.localhost/);
    expect(out).not.toMatch(/Excluded:[\s\S]*IP:/);
    expect(out).toMatch(/Signature Algorithm: ecdsa-with-SHA256/);
  });

  it('makes P-256 keys in PKCS#8', () => {
    for (const key of [ca.keyPem, leafIssued.keyPem, newKey()]) {
      expect(key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
      expect(createPrivateKey(key).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    }
    expect(new X509Certificate(leafIssued.certPem).publicKey.asymmetricKeyDetails?.namedCurve).toBe(
      'prime256v1'
    );
  });

  it('gives the leaf 90 days from an hour before now, serverAuth only, with its names', () => {
    expect(leafIssued.notBefore).toBe(sec(NOW - HOUR));
    expect(leafIssued.notAfter).toBe(sec(NOW + LEAF_LIFETIME_MS));
    const cert = new X509Certificate(leafIssued.certPem);
    expect(cert.subject).toBe('O=PiPulse\nCN=pipulse-check');
    expect(cert.ca).toBe(false);
    const out = text(leafIssued.certPem);
    expect(out).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(out).toMatch(/Key Usage: critical\s+Digital Signature\s/);
    expect(out).toMatch(/Extended Key Usage:\s+TLS Web Server Authentication\s/);
    expect(out).toMatch(/Subject Key Identifier/);
    expect(out).toMatch(/Authority Key Identifier/);
    expect(out).toMatch(
      /Subject Alternative Name:\s+DNS:pipulse-check, DNS:localhost, IP Address:127.0.0.1, IP Address:(0:0:0:0:0:0:0:1|::1)/
    );
  });

  it('asks for key identifiers by default', () => {
    expect(caRun.ca.cnf).toContain('subjectKeyIdentifier = hash');
    expect(leafRun.ca.cnf).toContain('subjectKeyIdentifier = hash');
    expect(leafRun.ca.cnf).toContain('authorityKeyIdentifier = keyid');
    expect(caRun.ca.cnf).toContain('nameConstraints = critical, permitted;DNS:pipulse-check');
    expect(leafRun.ca.cnf).toContain(
      'subjectAltName = DNS:pipulse-check, DNS:localhost, IP:127.0.0.1, IP:::1'
    );
  });
});

describe('leaf dates against the CA', () => {
  const issueAt = (now: number, lifetimeMs?: number) =>
    issueLeaf({
      openssl: TEST_OPENSSL,
      workDir: work,
      ca: caPaths,
      subject: 'pipulse-check',
      dns: ['pipulse-check'],
      ip: [],
      now,
      ...(lifetimeMs === undefined ? {} : { lifetimeMs })
    });

  it('starts an hour before now when that is after the CA start', async () => {
    const issued = await issueAt(NOW + 10 * 60_000);
    expect(issued.notBefore).toBe(sec(NOW + 10 * 60_000 - HOUR));
  });

  it('never starts before the CA does', async () => {
    const issued = await issueAt(NOW - 30 * 60_000);
    expect(issued.notBefore).toBe(ca.notBefore);
  });

  it('stops at the CA end', async () => {
    const issued = await issueAt(ca.notAfter - 5 * 86_400_000);
    expect(issued.notAfter).toBe(ca.notAfter);
  });

  it('honours a custom lifetime', async () => {
    const issued = await issueAt(NOW, 2 * 86_400_000);
    expect(issued.notAfter).toBe(sec(NOW + 2 * 86_400_000));
  });

  it('refuses a lifetime that is not positive and finite, naming it', async () => {
    for (const ms of [0, -1, NaN, Infinity]) {
      await expect(issueAt(NOW, ms)).rejects.toThrow(new IssueError('bad certificate lifetime'));
    }
  });

  it('refuses at the very moment the CA ends, with the fix in the message', async () => {
    const message = 'the CA has expired: make a new one with sudo pipulse tls new-ca';
    await expect(issueAt(ca.notAfter)).rejects.toThrow(new IssueError(message));
    await expect(issueAt(ca.notAfter + 1000)).rejects.toThrow(new IssueError(message));
  });
});

describe('verifyIssued', () => {
  it('refuses a CA certificate as a leaf', () => {
    expect(() => verifyIssued(ca.certPem, ca.certPem)).toThrow(
      new IssueError('the new certificate is a CA certificate')
    );
  });

  it('refuses a certificate another CA signed, even when the names match', () => {
    const message = new IssueError('the new certificate does not verify against the CA');
    // Unrelated key, same subject, no key identifiers: only the signature tells them apart.
    expect(() => verifyIssued(plainLeaf.certPem, ca.certPem)).toThrow(message);
    expect(() => verifyIssued(leafIssued.certPem, plainCa.certPem)).toThrow(message);
    expect(() => verifyIssued(leafIssued.certPem, caPaths.certPem)).not.toThrow();
    expect(() => verifyIssued(plainLeaf.certPem, plainCa.certPem)).not.toThrow();
  });

  it('refuses a certificate whose signature was altered, though the names and identifiers match', () => {
    const der = Buffer.from(new X509Certificate(leafIssued.certPem).raw);
    der[der.length - 1] = der[der.length - 1]! ^ 0x01;
    const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
    const tampered = new X509Certificate(pem);
    expect(tampered.checkIssued(new X509Certificate(ca.certPem))).toBe(true);
    expect(() => verifyIssued(pem, ca.certPem)).toThrow(
      new IssueError('the new certificate does not verify against the CA')
    );
  });

  it('is what issueLeaf runs: a CA file that does not match its certificate is caught', async () => {
    // The key file belongs to another CA with the same name: openssl signs, verification fails.
    await expect(
      issueLeaf({
        openssl: TEST_OPENSSL,
        workDir: work,
        ca: {
          keyPath: join(work, 'plain-ca.key'),
          certPath: caPaths.certPath,
          certPem: caPaths.certPem
        },
        subject: 'pipulse-check',
        dns: ['pipulse-check'],
        ip: [],
        now: NOW
      })
    ).rejects.toThrow(IssueError);
  });
});
