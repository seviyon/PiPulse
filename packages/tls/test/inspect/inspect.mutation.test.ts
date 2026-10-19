import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  CertificateRefused,
  inspectMaterial,
  loadCertificate,
  type Trust
} from '../../src/inspect/inspect.js';
import { fixture, tempDir } from '../helpers.js';
import { TEST_OPENSSL } from '../openssl.js';

const leaf = fixture('leaf.crt');
const intermediate = fixture('intermediate.crt');
const rootCa = fixture('root-ca.crt');
const BROKEN = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
const trustOf = (...anchors: string[]): Trust => ({ anchors, system: false });

const scratch = () => {
  const dir = tempDir();
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const ossl = (...args: string[]) => execFileSync(TEST_OPENSSL, args, { stdio: 'ignore' });
const read = (path: string) => readFileSync(path, 'utf8');

/** Two CAs with one subject and no key identifiers: only the signature tells them apart. */
function rolloverCas() {
  const dir = scratch();
  const p = (name: string) => join(dir, name);
  for (const k of ['old', 'new', 'leaf']) {
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p(`${k}.key`));
  }
  const bare = ['-addext', 'subjectKeyIdentifier=none', '-addext', 'authorityKeyIdentifier=none'];
  for (const k of ['old', 'new']) {
    ossl(
      'req',
      '-x509',
      '-new',
      '-key',
      p(`${k}.key`),
      '-sha256',
      '-days',
      '30',
      '-subj',
      '/CN=Rollover CA',
      '-out',
      p(`${k}.crt`),
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      ...bare
    );
  }
  writeFileSync(
    p('ext'),
    'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:roll.test\n' +
      'subjectKeyIdentifier=none\nauthorityKeyIdentifier=none\n'
  );
  ossl('req', '-new', '-key', p('leaf.key'), '-subj', '/CN=roll', '-out', p('leaf.csr'));
  ossl(
    'x509',
    '-req',
    '-in',
    p('leaf.csr'),
    '-CA',
    p('old.crt'),
    '-CAkey',
    p('old.key'),
    '-set_serial',
    '5',
    '-days',
    '30',
    '-extfile',
    p('ext'),
    '-out',
    p('leaf.crt')
  );
  const oldPem = read(p('old.crt'));
  const newPem = read(p('new.crt'));
  const leafPem = read(p('leaf.crt'));
  const lc = new X509Certificate(leafPem);
  // The setup this test relies on: the wrong CA looks like the issuer but did not sign.
  expect(lc.checkIssued(new X509Certificate(newPem))).toBe(true);
  expect(lc.verify(new X509Certificate(newPem).publicKey)).toBe(false);
  return { oldPem, newPem, leafPem, leafKey: read(p('leaf.key')) };
}

describe('mutation: error identity', () => {
  it('names the error class and records whether the message names its setting', () => {
    const plain = new CertificateRefused('x');
    expect(plain.name).toBe('CertificateRefused');
    expect(plain.named).toBe(false);
    expect(new CertificateRefused('x', true).named).toBe(true);
  });
});

describe('mutation: chain order and signatures', () => {
  it('refuses a certificate that has the right name but a different key than the signer', () => {
    const { newPem, leafPem, leafKey } = rolloverCas();
    expect(() =>
      inspectMaterial({
        source: 'operator',
        keyPem: leafKey,
        certPems: [leafPem, newPem],
        trust: trustOf(newPem),
        names: []
      })
    ).toThrow('certificate 2 did not issue certificate 1');
  });

  it('refuses an anchor of the issuer name whose key did not sign the chain', () => {
    const { newPem, leafPem, leafKey } = rolloverCas();
    const run = () =>
      inspectMaterial({
        source: 'operator',
        keyPem: leafKey,
        certPems: [leafPem],
        trust: trustOf(newPem),
        names: []
      });
    expect(run).toThrow(CertificateRefused);
    expect(run).toThrow("the chain's signature by its certificate authority is invalid");
  });

  it('prefers, among same-name anchors listed first, the one whose key signed the chain', () => {
    const { oldPem, newPem, leafPem, leafKey } = rolloverCas();
    const loaded = inspectMaterial({
      source: 'generated',
      keyPem: leafKey,
      certPems: [leafPem],
      trust: trustOf(newPem, oldPem),
      names: []
    });
    expect(loaded.class).toBe('valid');
    expect(loaded.caFingerprint).toBe(new X509Certificate(oldPem).fingerprint256);
  });

  it('refuses a server certificate that signed the one below it, naming its position', () => {
    const dir = scratch();
    const p = (name: string) => join(dir, name);
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('s.key'));
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('l.key'));
    ossl(
      'req',
      '-x509',
      '-new',
      '-key',
      p('s.key'),
      '-sha256',
      '-days',
      '30',
      '-subj',
      '/CN=signer',
      '-out',
      p('s.crt'),
      '-addext',
      'basicConstraints=critical,CA:FALSE'
    );
    ossl('req', '-new', '-key', p('l.key'), '-subj', '/CN=below', '-out', p('l.csr'));
    writeFileSync(p('ext'), 'basicConstraints=critical,CA:FALSE\n');
    ossl(
      'x509',
      '-req',
      '-in',
      p('l.csr'),
      '-CA',
      p('s.crt'),
      '-CAkey',
      p('s.key'),
      '-set_serial',
      '7',
      '-days',
      '30',
      '-extfile',
      p('ext'),
      '-out',
      p('l.crt')
    );
    const signerPem = read(p('s.crt'));
    expect(new X509Certificate(signerPem).ca).toBe(false);
    expect(() =>
      inspectMaterial({
        source: 'operator',
        keyPem: read(p('l.key')),
        certPems: [read(p('l.crt')), signerPem],
        trust: trustOf(signerPem),
        names: []
      })
    ).toThrow("certificate 2 is not a CA certificate, so it can't have issued certificate 1");
  });
});

describe('mutation: anchors that loop', () => {
  it('ends climbing when two anchors certify each other, as an incomplete chain', () => {
    const dir = scratch();
    const p = (name: string) => join(dir, name);
    for (const k of ['k1', 'k2', 'k3']) {
      ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p(`${k}.key`));
    }
    writeFileSync(p('ca.ext'), 'basicConstraints=critical,CA:TRUE\n');
    writeFileSync(
      p('leaf.ext'),
      'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:loop.test\n'
    );
    for (const [k, cn] of [
      ['k1', 'X1'],
      ['k2', 'X2']
    ] as const) {
      ossl(
        'req',
        '-x509',
        '-new',
        '-key',
        p(`${k}.key`),
        '-sha256',
        '-days',
        '30',
        '-subj',
        `/CN=${cn}`,
        '-out',
        p(`${cn}.self.crt`),
        '-addext',
        'basicConstraints=critical,CA:TRUE'
      );
      ossl('req', '-new', '-key', p(`${k}.key`), '-subj', `/CN=${cn}`, '-out', p(`${cn}.csr`));
    }
    // X1 is certified by X2's key and X2 by X1's key: neither is self-issued.
    ossl(
      'x509',
      '-req',
      '-in',
      p('X1.csr'),
      '-CA',
      p('X2.self.crt'),
      '-CAkey',
      p('k2.key'),
      '-set_serial',
      '1',
      '-days',
      '30',
      '-extfile',
      p('ca.ext'),
      '-out',
      p('X1.crt')
    );
    ossl(
      'x509',
      '-req',
      '-in',
      p('X2.csr'),
      '-CA',
      p('X1.self.crt'),
      '-CAkey',
      p('k1.key'),
      '-set_serial',
      '2',
      '-days',
      '30',
      '-extfile',
      p('ca.ext'),
      '-out',
      p('X2.crt')
    );
    ossl('req', '-new', '-key', p('k3.key'), '-subj', '/CN=loop', '-out', p('leaf.csr'));
    ossl(
      'x509',
      '-req',
      '-in',
      p('leaf.csr'),
      '-CA',
      p('X1.self.crt'),
      '-CAkey',
      p('k1.key'),
      '-set_serial',
      '3',
      '-days',
      '30',
      '-extfile',
      p('leaf.ext'),
      '-out',
      p('leaf.crt')
    );
    const loaded = inspectMaterial({
      source: 'operator',
      keyPem: read(p('k3.key')),
      certPems: [read(p('leaf.crt'))],
      trust: trustOf(read(p('X1.crt')), read(p('X2.crt'))),
      names: []
    });
    expect(loaded.class).toBe('degraded-incomplete-chain');
    expect(loaded.reasons).toEqual(['incomplete-chain']);
  });
});

describe('mutation: reasons and class ranking', () => {
  it('lists one reason once when several steps raise it', () => {
    // intermediate only in the trust file (not served), and no root above it.
    const cert = inspectMaterial({
      source: 'operator',
      keyPem: fixture('leaf.key'),
      certPems: [leaf],
      trust: trustOf(intermediate),
      names: []
    });
    expect(cert.class).toBe('degraded-incomplete-chain');
    expect(cert.reasons).toEqual(['incomplete-chain']);
  });

  it('keeps the worse class when a better-ranked problem is found later', () => {
    const cert = inspectMaterial({
      source: 'operator',
      keyPem: fixture('other-leaf.key'),
      certPems: [fixture('other-leaf.crt'), fixture('other-ca.crt')],
      trust: trustOf(),
      names: ['not-in-the-certificate.invalid']
    });
    expect(cert.reasons).toEqual(['untrusted', 'san-missing']);
    expect(cert.class).toBe('degraded-untrusted');
  });

  it('keeps the first of two equally ranked classes', () => {
    const dir = scratch();
    const p = (name: string) => join(dir, name);
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('k.key'));
    ossl(
      'req',
      '-x509',
      '-new',
      '-key',
      p('k.key'),
      '-sha256',
      '-days',
      '30',
      '-subj',
      '/CN=solo',
      '-out',
      p('c.crt'),
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'subjectAltName=DNS:solo',
      '-addext',
      'extendedKeyUsage=clientAuth'
    );
    const cert = inspectMaterial({
      source: 'operator',
      keyPem: read(p('k.key')),
      certPems: [read(p('c.crt'))],
      trust: trustOf(),
      names: []
    });
    expect(cert.reasons).toEqual(['untrusted', 'no-server-auth']);
    expect(cert.class).toBe('degraded-untrusted');
  });
});

describe('mutation: anchor errors name their file', () => {
  it.each([
    ['operator', 'PIPULSE_TLS_CA'],
    ['generated', 'ca.crt']
  ] as const)('a broken anchor of a %s source says %s', (source, name) => {
    expect(() =>
      inspectMaterial({
        source,
        keyPem: fixture('leaf.key'),
        certPems: [leaf, intermediate],
        trust: trustOf(BROKEN),
        names: []
      })
    ).toThrow(new RegExp(`^${name}: certificate 1 can't be parsed$`));
  });
});

describe('mutation: the validity window', () => {
  it('leaves a served root out of the window, whatever its dates', () => {
    const dir = scratch();
    const p = (name: string) => join(dir, name);
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('r.key'));
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('l.key'));
    // The root is valid for 5 days, the leaf for 40: a root in the window would narrow it.
    ossl(
      'req',
      '-x509',
      '-new',
      '-key',
      p('r.key'),
      '-sha256',
      '-days',
      '5',
      '-subj',
      '/CN=Short Root',
      '-out',
      p('r.crt'),
      '-addext',
      'basicConstraints=critical,CA:TRUE'
    );
    ossl('req', '-new', '-key', p('l.key'), '-subj', '/CN=long-leaf', '-out', p('l.csr'));
    writeFileSync(p('ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:long.test\n');
    ossl(
      'x509',
      '-req',
      '-in',
      p('l.csr'),
      '-CA',
      p('r.crt'),
      '-CAkey',
      p('r.key'),
      '-set_serial',
      '9',
      '-days',
      '40',
      '-extfile',
      p('ext'),
      '-out',
      p('l.crt')
    );
    const leafPem = read(p('l.crt'));
    const rootPem = read(p('r.crt'));
    const loaded = inspectMaterial({
      source: 'operator',
      keyPem: read(p('l.key')),
      certPems: [leafPem, rootPem],
      trust: trustOf(rootPem),
      names: []
    });
    const parsed = new X509Certificate(leafPem);
    expect(loaded.class).toBe('valid');
    expect(loaded.notAfter).toBe(parsed.validToDate.getTime());
    expect(loaded.notAfter).toBeGreaterThan(new X509Certificate(rootPem).validToDate.getTime());
  });
});

describe('mutation: what is served', () => {
  it('fingerprints the key, a NUL and the chain exactly', () => {
    const keyPem = fixture('leaf.key');
    const cert = inspectMaterial({
      source: 'operator',
      keyPem,
      certPems: [leaf, intermediate],
      trust: trustOf(rootCa),
      names: []
    });
    const expected = createHash('sha256')
      .update(keyPem)
      .update('\0')
      .update(leaf + intermediate)
      .digest('hex');
    expect(cert.contextFingerprint).toBe(expected);
  });
});

describe('mutation: loadCertificate policies and names', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, text: string, mode = 0o600) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    chmodSync(path, mode);
    return path;
  };
  const ok = () => ({
    cert: put('cert.pem', leaf + intermediate, 0o644),
    key: put('key.pem', fixture('leaf.key')),
    ca: put('ca.pem', rootCa, 0o644)
  });
  const operator = (over: Record<string, string>) => {
    const f = ok();
    return loadCertificate(
      { kind: 'operator', certPath: f.cert, keyPath: f.key, caPath: f.ca, ...over },
      { names: [] }
    );
  };
  const generated = (over: Record<string, string>, owner?: { uid?: number; gid?: number }) =>
    loadCertificate(
      {
        kind: 'generated',
        bundlePath: put('leaf.pem', fixture('leaf.key') + leaf + intermediate, 0o640),
        caPath: put('ca.crt', rootCa, 0o644),
        ...over
      },
      { names: [], ...(owner ? { generatedOwner: owner } : {}) }
    );

  it('puts the setting in front of a refusal that is not named yet, and marks it named', () => {
    const f = ok();
    try {
      operator({ keyPath: put('other.key', fixture('leaf2.key')) });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CertificateRefused);
      expect((error as CertificateRefused).named).toBe(true);
      expect((error as CertificateRefused).message).toMatch(/^PIPULSE_TLS_CERT\/PIPULSE_TLS_KEY: /);
    }
    expect(f.cert).toBeTruthy();
    try {
      generated({ bundlePath: put('b.pem', fixture('leaf2.key') + leaf + intermediate, 0o640) });
      expect.unreachable();
    } catch (error) {
      expect((error as CertificateRefused).named).toBe(true);
      expect((error as CertificateRefused).message).toMatch(/^b\.pem: /);
    }
  });

  it.each([
    ['PIPULSE_TLS_CERT', 'certPath'],
    ['PIPULSE_TLS_KEY', 'keyPath'],
    ['PIPULSE_TLS_CA', 'caPath']
  ])('names %s when its file is empty', (name, field) => {
    expect(() => operator({ [field]: put(`empty-${field}`, '') })).toThrow(
      new RegExp(`^${name} is empty`)
    );
  });

  it.each([
    ['PIPULSE_TLS_CERT', 'certPath'],
    ['PIPULSE_TLS_KEY', 'keyPath'],
    ['PIPULSE_TLS_CA', 'caPath']
  ])('names %s when its file is missing', (name, field) => {
    expect(() => operator({ [field]: join(dir, 'absent') })).toThrow(
      new RegExp(`^${name}: file not found`)
    );
  });

  it('refuses an operator key that every user can read', () => {
    expect(() => operator({ keyPath: put('open.key', fixture('leaf.key'), 0o644) })).toThrow(
      /^PIPULSE_TLS_KEY: readable by every user/
    );
  });

  it.each([
    ['leaf.pem', 'bundlePath'],
    ['ca.crt', 'caPath']
  ])('names %s when it is empty or missing', (name, field) => {
    expect(() => generated({ [field]: put(`empty-${field}`, '', 0o600) })).toThrow(
      new RegExp(`^${name.replace('.', '\\.')} is empty`)
    );
    expect(() => generated({ [field]: join(dir, 'absent') })).toThrow(
      new RegExp(`^${name.replace('.', '\\.')}: file not found`)
    );
  });

  it('does not follow a symlink for generated material', () => {
    const real = put('real.pem', fixture('leaf.key') + leaf + intermediate, 0o640);
    const link = join(dir, 'link.pem');
    symlinkSync(real, link);
    expect(() => generated({ bundlePath: link })).toThrow(/^leaf\.pem: /);
    const realCa = put('real-ca.crt', rootCa, 0o644);
    const caLink = join(dir, 'ca-link.crt');
    symlinkSync(realCa, caLink);
    expect(() => generated({ caPath: caLink })).toThrow(/^ca\.crt: /);
  });

  it('holds generated files to the owner it was given', () => {
    const uid = process.getuid!();
    const gid = process.getgid!();
    expect(generated({}, { uid, gid }).class).toBe('valid');
    expect(() => generated({}, { uid: uid + 1 })).toThrow(/^leaf\.pem: owned by uid/);
    expect(() => generated({}, { gid: gid + 1 })).toThrow(/^leaf\.pem: group /);
  });
});
