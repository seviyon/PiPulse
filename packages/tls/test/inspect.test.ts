import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CertificateRefused,
  CLASS_RANK,
  inspectMaterial,
  loadCertificate,
  parseSans,
  validityOf,
  type Trust
} from '../src/inspect.js';
import { fixture, tempDir } from './helpers.js';

const root: Trust = { anchors: [fixture('root-ca.crt')], system: false };
const inspect = (certs: string[], key = fixture('leaf.key'), trust = root, names: string[] = []) =>
  inspectMaterial({ source: 'operator', keyPem: key, certPems: certs, trust, names });
const leaf = fixture('leaf.crt');
const intermediate = fixture('intermediate.crt');

describe('inspectMaterial, accepted material', () => {
  it('classes a complete chain to a trusted root as valid', () => {
    const cert = inspect([leaf, intermediate]);
    expect(cert.class).toBe('valid');
    expect(cert.reasons).toEqual([]);
    expect(cert.sans).toEqual({ dns: ['localhost', 'pipulse.test'], ip: ['127.0.0.1'] });
    expect(cert.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(cert.notAfter).toBe(Date.UTC(2125, 0, 1));
    expect(cert.cert).toBe(leaf + intermediate);
  });

  it('accepts the root itself at the end of the chain', () => {
    expect(inspect([leaf, intermediate, fixture('root-ca.crt')]).class).toBe('valid');
  });

  it('classes a missing intermediate as degraded-incomplete-chain', () => {
    expect(inspect([leaf])).toMatchObject({
      class: 'degraded-incomplete-chain',
      reasons: ['incomplete-chain']
    });
  });

  it('narrows the validity window to an expired intermediate instead of refusing', () => {
    const cert = inspect(
      [fixture('under-expired.crt'), fixture('expired-intermediate.crt')],
      fixture('under-expired.key')
    );
    expect(cert.class).toBe('valid');
    expect(cert.notBefore).toBe(Date.UTC(2026, 0, 1));
    expect(cert.notAfter).toBe(Date.UTC(2021, 0, 1));
    expect(validityOf(cert, Date.UTC(2026, 8, 30), 0)).toBe('expired');
  });

  it('does not narrow the window to a root supplied at the end of the chain', () => {
    const cert = inspect([leaf, intermediate, fixture('root-ca.crt')]);
    expect(cert.notBefore).toBe(Date.UTC(2026, 0, 1));
    expect(cert.notAfter).toBe(Date.UTC(2125, 0, 1));
  });

  it('classes a chain to an unexpected root as degraded-untrusted', () => {
    const cert = inspect(
      [fixture('other-leaf.crt'), fixture('other-ca.crt')],
      fixture('other-leaf.key')
    );
    expect(cert).toMatchObject({ class: 'degraded-untrusted', reasons: ['untrusted'] });
  });

  it('classes a configured name the certificate misses as degraded-san', () => {
    const cert = inspect([leaf, intermediate], fixture('leaf.key'), root, [
      'pipulse.test',
      'io.lan',
      '127.0.0.1',
      '10.0.0.1'
    ]);
    expect(cert).toMatchObject({
      class: 'degraded-san',
      reasons: ['san-missing'],
      missingNames: ['io.lan', '10.0.0.1']
    });
  });

  it('keeps the worst class when several apply', () => {
    const cert = inspect([leaf], fixture('leaf.key'), { anchors: [], system: true }, ['io.lan']);
    expect(cert.class).toBe('degraded-san');
    expect(cert.reasons).toEqual(['incomplete-chain', 'san-missing']);
    expect(CLASS_RANK['degraded-san']).toBeLessThan(CLASS_RANK['degraded-incomplete-chain']);
  });

  it.each(['leaf.key', 'leaf.ec.key'])('matches the key in %s form', (keyFile) => {
    expect(inspect([leaf, intermediate], fixture(keyFile)).class).toBe('valid');
  });

  it('accepts an RSA key and certificate', () => {
    expect(
      inspect([fixture('rsa-leaf.crt'), intermediate], fixture('rsa-leaf.rsa.key')).class
    ).toBe('valid');
  });
});

describe('inspectMaterial, names', () => {
  it('does not take the subject CN for a name (no CN fallback)', () => {
    const cert = inspect([fixture('cn-only.crt'), intermediate], fixture('cn-only.key'), root, [
      'io.lan'
    ]);
    expect(cert).toMatchObject({
      class: 'degraded-san',
      reasons: ['san-missing'],
      missingNames: ['io.lan']
    });
  });
});

describe('inspectMaterial, refused material', () => {
  it.each([
    [
      'a key for another certificate',
      [leaf, intermediate],
      fixture('leaf2.key'),
      'does not match the first certificate'
    ],
    [
      'a key matching only a later certificate',
      [intermediate, leaf],
      fixture('leaf.key'),
      'does not match the first certificate'
    ],
    [
      'a CA certificate as the leaf',
      [intermediate, fixture('root-ca.crt')],
      fixture('intermediate.key'),
      'is a CA certificate'
    ],
    [
      'the same certificate twice',
      [leaf, leaf, intermediate],
      fixture('leaf.key'),
      'same certificate twice'
    ],
    [
      'an unrelated certificate in the chain',
      [leaf, fixture('other-ca.crt')],
      fixture('leaf.key'),
      'did not issue certificate 1'
    ],
    [
      'a chain in the wrong order',
      [leaf, fixture('root-ca.crt'), intermediate],
      fixture('leaf.key'),
      'certificate 2 did not issue certificate 1'
    ],
    [
      'an unparseable certificate',
      [leaf, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'],
      fixture('leaf.key'),
      "certificate 2 can't be parsed"
    ],
    [
      'an unparseable key',
      [leaf],
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
      "private key can't be parsed"
    ]
  ])('refuses %s', (_name, certs, key, message) => {
    expect(() => inspect(certs, key)).toThrow(CertificateRefused);
    expect(() => inspect(certs, key)).toThrow(message);
  });
});

describe('validityOf', () => {
  const cert = { notBefore: 1000, notAfter: 1000 + 40 * 86_400_000 };
  const soon = 30 * 86_400_000;
  it.each([
    [999, 'not-yet-valid'],
    [1000, 'valid'],
    [cert.notAfter - soon - 1, 'valid'],
    [cert.notAfter - soon, 'expiring-soon'],
    [cert.notAfter - 1, 'expiring-soon'],
    [cert.notAfter, 'expired']
  ] as const)('at %d is %s', (now, validity) => {
    expect(validityOf(cert, now, soon)).toBe(validity);
  });
});

describe('parseSans', () => {
  it('reads DNS and IP entries and ignores others', () => {
    expect(parseSans('DNS:a.test, IP Address:::1, email:x@y, DNS:b.test')).toEqual({
      dns: ['a.test', 'b.test'],
      ip: ['::1']
    });
    expect(parseSans(undefined)).toEqual({ dns: [], ip: [] });
  });
});

describe('loadCertificate', () => {
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

  it('loads operator files, trusting PIPULSE_TLS_CA when set', () => {
    const cert = loadCertificate(
      {
        kind: 'operator',
        certPath: put('cert.pem', leaf + intermediate, 0o644),
        keyPath: put('key.pem', fixture('leaf.key')),
        caPath: put('ca.pem', fixture('root-ca.crt'), 0o644)
      },
      { names: [] }
    );
    expect(cert).toMatchObject({ source: 'operator', class: 'valid' });
  });

  it('trusts the system store without PIPULSE_TLS_CA (a private root is then untrusted)', () => {
    const cert = loadCertificate(
      {
        kind: 'operator',
        certPath: put('cert.pem', leaf + intermediate + fixture('root-ca.crt'), 0o644),
        keyPath: put('key.pem', fixture('leaf.key'))
      },
      { names: [] }
    );
    expect(cert.class).toBe('degraded-untrusted');
  });

  it('loads a generated bundle against its CA and records the CA fingerprint', () => {
    const uid = process.getuid!();
    const gid = process.getgid!();
    const cert = loadCertificate(
      {
        kind: 'generated',
        bundlePath: put('leaf.pem', fixture('leaf.key') + leaf + intermediate, 0o640),
        caPath: put('ca.crt', fixture('root-ca.crt'), 0o644)
      },
      { names: [], generatedOwner: { uid, gid } }
    );
    expect(cert).toMatchObject({ source: 'generated', class: 'valid' });
    expect(cert.caFingerprint).toMatch(/^[0-9A-F:]{95}$/);
  });

  it('names the setting when a file is missing', () => {
    expect(() =>
      loadCertificate(
        { kind: 'operator', certPath: join(dir, 'none'), keyPath: join(dir, 'none') },
        { names: [] }
      )
    ).toThrow('PIPULSE_TLS_CERT: file not found');
  });

  it('names the setting when the key does not match', () => {
    expect(() =>
      loadCertificate(
        {
          kind: 'operator',
          certPath: put('cert.pem', leaf + intermediate, 0o644),
          keyPath: put('key.pem', fixture('leaf2.key'))
        },
        { names: [] }
      )
    ).toThrow(/^PIPULSE_TLS_CERT\/PIPULSE_TLS_KEY: the private key does not match/);
  });

  it('refuses a well-framed but broken PIPULSE_TLS_CA with its name, once', () => {
    const broken = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
    const source = {
      kind: 'operator' as const,
      certPath: put('cert.pem', leaf + intermediate, 0o644),
      keyPath: put('key.pem', fixture('leaf.key')),
      caPath: put('ca.pem', broken, 0o644)
    };
    expect(() => loadCertificate(source, { names: [] })).toThrow(CertificateRefused);
    expect(() => loadCertificate(source, { names: [] })).toThrow(
      /^PIPULSE_TLS_CA: certificate 1 can't be parsed$/
    );
  });

  it('names the bundle file when a generated bundle is refused', () => {
    const uid = process.getuid!();
    const gid = process.getgid!();
    expect(() =>
      loadCertificate(
        {
          kind: 'generated',
          bundlePath: put('leaf.pem', fixture('leaf2.key') + leaf + intermediate, 0o640),
          caPath: put('ca.crt', fixture('root-ca.crt'), 0o644)
        },
        { names: [], generatedOwner: { uid, gid } }
      )
    ).toThrow(/^leaf\.pem: the private key does not match/);
  });
});
