import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign, X509Certificate } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CertificateRefused, inspectMaterial } from '../../src/inspect/inspect.js';
import { nameConstraints, pathLength } from '../../src/inspect/x509-constraints.js';
import { fixture, tempDir } from '../helpers.js';
import { TEST_OPENSSL } from '../openssl.js';

// A client enforces what OpenSSL accepts, and OpenSSL accepts encodings (BER lengths, odd
// subtrees) that PiPulse's own DER reader cannot follow. A constraint it cannot read must
// degrade the chain, never read as "no constraint". The certificates are made with OpenSSL and
// then re-encoded, so only the one extension under test differs.

const OID_BASIC = '551d13';
const OID_NAME_CONSTRAINTS = '551d1e';

const lengthBytes = (n: number): Buffer => {
  if (n < 128) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
};

interface Node {
  tag: number;
  raw: Buffer;
  body: Buffer;
  kids?: Node[];
}
function parse(buf: Buffer, at = 0): Node & { next: number } {
  const tag = buf[at]!;
  let length = buf[at + 1]!;
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[start + i]!;
    start += count;
  }
  const end = start + length;
  const body = buf.subarray(start, end);
  const node: Node & { next: number } = { tag, raw: buf.subarray(at, end), body, next: end };
  if (tag & 0x20) {
    node.kids = [];
    for (let p = 0; p < body.length;) {
      const kid = parse(body, p);
      node.kids.push(kid);
      p = kid.next;
    }
  }
  return node;
}

let dir: string;
beforeAll(() => {
  dir = tempDir();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const openssl = (...args: string[]) =>
  execFileSync(TEST_OPENSSL, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });

const pemOf = (der: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END CERTIFICATE-----\n`;

/** A root with a name constraint and a path length, and a leaf it signed for good.test. */
let made: { rootPem: string; rootKey: string; leafPem: string; leafKey: string };
beforeAll(() => {
  const f = (name: string) => join(dir, name);
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('root.key'));
  writeFileSync(
    f('root.cnf'),
    [
      '[req]',
      'distinguished_name=dn',
      'prompt=no',
      '[dn]',
      'CN=Root',
      '[v3]',
      'basicConstraints=critical,CA:TRUE,pathlen:5',
      'keyUsage=keyCertSign',
      'subjectKeyIdentifier=hash',
      'nameConstraints=critical,permitted;DNS:good.test'
    ].join('\n')
  );
  openssl(
    'req',
    '-new',
    '-x509',
    '-key',
    f('root.key'),
    '-sha256',
    '-days',
    '30',
    '-config',
    f('root.cnf'),
    '-extensions',
    'v3',
    '-out',
    f('root.crt')
  );
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('leaf.key'));
  openssl('req', '-new', '-key', f('leaf.key'), '-subj', '/CN=leaf', '-out', f('leaf.csr'));
  writeFileSync(
    f('leaf.ext'),
    'subjectAltName=DNS:www.good.test\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid\n'
  );
  openssl(
    'x509',
    '-req',
    '-in',
    f('leaf.csr'),
    '-CA',
    f('root.crt'),
    '-CAkey',
    f('root.key'),
    '-CAcreateserial',
    '-days',
    '30',
    '-sha256',
    '-extfile',
    f('leaf.ext'),
    '-out',
    f('leaf.crt')
  );
  made = {
    rootPem: readFileSync(f('root.crt'), 'utf8'),
    rootKey: readFileSync(f('root.key'), 'utf8'),
    leafPem: readFileSync(f('leaf.crt'), 'utf8'),
    leafKey: readFileSync(f('leaf.key'), 'utf8')
  };
});

/**
 * The root, re-encoded: `change` gets the extension list (as nodes) and returns the new
 * extensions as raw TLVs; the TBS is re-signed with the root's key so OpenSSL still accepts it.
 */
function rewrite(change: (extensions: Node[]) => Buffer[]): X509Certificate {
  const der = new X509Certificate(made.rootPem).raw;
  const cert = parse(der);
  const tbs = cert.kids![0]!;
  const wrapper = tbs.kids!.find((k) => k.tag === 0xa3)!;
  const list = wrapper.kids![0]!;
  const newList = tlv(0x30, ...change(list.kids!));
  const newTbs = tlv(0x30, ...tbs.kids!.map((k) => (k === wrapper ? tlv(0xa3, newList) : k.raw)));
  const signature = sign('sha256', newTbs, createPrivateKey(made.rootKey));
  const sigBits = tlv(0x03, Buffer.from([0]), signature);
  return new X509Certificate(pemOf(tlv(0x30, newTbs, cert.kids![1]!.raw, sigBits)));
}

/** An extension with this OID (hex) and this value (the bytes inside its OCTET STRING). */
const extensionWith = (oidHex: string, value: Buffer, critical = true) =>
  tlv(
    0x30,
    tlv(0x06, Buffer.from(oidHex, 'hex')),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    tlv(0x04, value)
  );
const oidOf = (ext: Node) => ext.kids![0]!.body.toString('hex');
/** The list with one extension's raw TLV swapped. */
const replacing = (extensions: Node[], oidHex: string, replacement: Buffer) =>
  extensions.map((ext) => (oidOf(ext) === oidHex ? replacement : ext.raw));

const inspect = (root: X509Certificate) =>
  inspectMaterial({
    source: 'operator',
    keyPem: made.leafKey,
    certPems: [made.leafPem],
    trust: { anchors: [root.toString()], system: false },
    names: []
  });

describe('the re-encoding helper', () => {
  it('leaves a readable constraint readable, and the chain valid', () => {
    const same = rewrite((extensions) => extensions.map((ext) => ext.raw));
    expect(nameConstraints(same)).toMatchObject({ permitted: { dns: ['good.test'] } });
    expect(pathLength(same)).toBe(5);
    expect(inspect(same).class).toBe('valid');
  });
});

describe('name constraints PiPulse cannot read', () => {
  const dnsSubtree = tlv(0x30, tlv(0x82, Buffer.from('good.test')));
  const cases: [string, (extensions: Node[]) => Buffer[]][] = [
    [
      'an indefinite-length sequence (BER, which OpenSSL accepts)',
      (extensions) => {
        const original = extensions.find((e) => oidOf(e) === OID_NAME_CONSTRAINTS)!;
        const inner = parse(original.kids!.at(-1)!.body);
        return replacing(
          extensions,
          OID_NAME_CONSTRAINTS,
          extensionWith(
            OID_NAME_CONSTRAINTS,
            Buffer.concat([Buffer.from([0x30, 0x80]), inner.body, Buffer.from([0, 0])])
          )
        );
      }
    ],
    [
      'a permitted address that is neither 8 nor 32 bytes',
      (extensions) =>
        replacing(
          extensions,
          OID_NAME_CONSTRAINTS,
          extensionWith(
            OID_NAME_CONSTRAINTS,
            tlv(0x30, tlv(0xa0, dnsSubtree, tlv(0x30, tlv(0x87, Buffer.from([10, 0, 0, 0, 0])))))
          )
        )
    ],
    [
      'a subtree with no base',
      (extensions) =>
        replacing(
          extensions,
          OID_NAME_CONSTRAINTS,
          extensionWith(OID_NAME_CONSTRAINTS, tlv(0x30, tlv(0xa0, dnsSubtree, tlv(0x30))))
        )
    ],
    [
      'a group that is neither permitted nor excluded',
      (extensions) =>
        replacing(
          extensions,
          OID_NAME_CONSTRAINTS,
          extensionWith(OID_NAME_CONSTRAINTS, tlv(0x30, tlv(0xa2, dnsSubtree)))
        )
    ],
    [
      'a subtree with a minimum (OpenSSL refuses a bound, so a client would too)',
      (extensions) =>
        replacing(
          extensions,
          OID_NAME_CONSTRAINTS,
          extensionWith(
            OID_NAME_CONSTRAINTS,
            tlv(
              0x30,
              tlv(0xa0, tlv(0x30, tlv(0x82, Buffer.from('good.test')), tlv(0x80, Buffer.from([1]))))
            )
          )
        )
    ],
    [
      'a subtree with a maximum',
      (extensions) =>
        replacing(
          extensions,
          OID_NAME_CONSTRAINTS,
          extensionWith(
            OID_NAME_CONSTRAINTS,
            tlv(
              0x30,
              tlv(0xa0, tlv(0x30, tlv(0x82, Buffer.from('good.test')), tlv(0x81, Buffer.from([5]))))
            )
          )
        )
    ],
    [
      'bytes after the sequence inside the extension',
      (extensions) =>
        replacing(
          extensions,
          OID_NAME_CONSTRAINTS,
          extensionWith(
            OID_NAME_CONSTRAINTS,
            Buffer.concat([tlv(0x30, tlv(0xa0, dnsSubtree)), Buffer.from([0x00])])
          )
        )
    ],
    [
      'the extension twice',
      (extensions) => {
        const original = extensions.find((e) => oidOf(e) === OID_NAME_CONSTRAINTS)!;
        return [...extensions.map((e) => e.raw), original.raw];
      }
    ]
  ];

  // OpenSSL builds a chain only through a CA whose extensions it accepts: these are the ones it
  // does, and a reader that took them for "no constraint" would hide what clients enforce.
  const openSslAccepts = new Set([
    'an indefinite-length sequence (BER, which OpenSSL accepts)',
    'a permitted address that is neither 8 nor 32 bytes',
    'bytes after the sequence inside the extension'
  ]);

  it.each(cases)('read as unreadable: %s', (name, change) => {
    const root = rewrite(change);
    expect(nameConstraints(root)).toBe('unreadable');
    const result = inspect(root);
    expect(result.class).not.toBe('valid');
    if (openSslAccepts.has(name)) {
      expect(result.class).toBe('degraded-untrusted');
      expect(result.reasons).toContain('name-constraint');
    }
  });
});

describe('a path length PiPulse cannot read', () => {
  const cases: [string, Buffer][] = [
    [
      'a negative number',
      tlv(0x30, tlv(0x01, Buffer.from([0xff])), tlv(0x02, Buffer.from([0xff])))
    ],
    [
      'bytes after the sequence',
      Buffer.concat([tlv(0x30, tlv(0x01, Buffer.from([0xff]))), Buffer.from([0])])
    ],
    [
      'an indefinite-length sequence',
      Buffer.concat([
        Buffer.from([0x30, 0x80]),
        tlv(0x01, Buffer.from([0xff])),
        Buffer.from([0, 0])
      ])
    ]
  ];

  it.each(cases)('is unreadable: %s', (name, value) => {
    const root = rewrite((extensions) =>
      replacing(extensions, OID_BASIC, extensionWith(OID_BASIC, value))
    );
    expect(pathLength(root)).toBe('unreadable');
    const result = inspect(root);
    expect(result.class).not.toBe('valid');
    if (name !== 'a negative number') {
      expect(result.class).toBe('degraded-untrusted');
      expect(result.reasons).toContain('path-length');
    }
  });
});

describe('a certificate the crypto library cannot check', () => {
  // Certificates with a key type the bundled OpenSSL cannot decode (a post-quantum key under an
  // older Node, say) can only be made portably by making verify() fail the way it does then.
  const attempt = () =>
    inspectMaterial({
      source: 'operator',
      keyPem: fixture('leaf.key'),
      certPems: [fixture('leaf.crt'), fixture('intermediate.crt')],
      trust: { anchors: [fixture('root-ca.crt')], system: false },
      names: []
    });
  afterEach(() => vi.restoreAllMocks());

  it('is refused with a message that names no secret, not thrown as a bare crypto error', () => {
    vi.spyOn(X509Certificate.prototype, 'verify').mockImplementation(() => {
      throw Object.assign(new Error('error:03000072:digital envelope routines::decode error'), {
        code: 'ERR_OSSL_EVP_DECODE_ERROR'
      });
    });
    expect(attempt).toThrow(CertificateRefused);
    expect(attempt).toThrow("the certificate or key can't be checked (ERR_OSSL_EVP_DECODE_ERROR)");
  });

  it('also refuses an error from the crypto layer, whatever its code ends with', () => {
    vi.spyOn(X509Certificate.prototype, 'verify').mockImplementation(() => {
      throw Object.assign(new Error('bad'), { code: 'ERR_CRYPTO_INVALID_KEY' });
    });
    expect(attempt).toThrow("the certificate or key can't be checked (ERR_CRYPTO_INVALID_KEY)");
  });

  it.each(['ENOENT', 'NOT_ERR_OSSL_AT_THE_START'])(
    'leaves an error whose code is %s alone',
    (code) => {
      const failure = Object.assign(new Error('other'), { code });
      vi.spyOn(X509Certificate.prototype, 'verify').mockImplementation(() => {
        throw failure;
      });
      expect(attempt).toThrow(failure);
    }
  );

  it('rethrows something that is not an error at all, as it was', () => {
    vi.spyOn(X509Certificate.prototype, 'verify').mockImplementation(() => {
      throw null;
    });
    let caught: unknown = 'nothing was thrown';
    try {
      attempt();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeNull();
  });

  it('leaves any other error alone, so a bug is not mistaken for a bad certificate', () => {
    vi.spyOn(X509Certificate.prototype, 'verify').mockImplementation(() => {
      throw new TypeError('a bug');
    });
    expect(attempt).toThrow(TypeError);
  });
});

describe('a root whose issuer name differs from its subject only in case', () => {
  // Names match without regard to case (RFC 5280), so OpenSSL calls this root self-issued, and
  // it is signed by its own key: self-signed all the same.
  function recased(): X509Certificate {
    const der = new X509Certificate(made.rootPem).raw;
    const cert = parse(der);
    const tbs = cert.kids![0]!;
    // version, serial, signature algorithm, ISSUER, validity, subject, ...
    const issuerIndex = tbs.kids!.findIndex(
      (k) => k.tag === 0x30 && k.raw.includes(Buffer.from('Root'))
    );
    const issuer = tbs.kids![issuerIndex]!;
    const at = issuer.raw.indexOf(Buffer.from('Root'));
    const changed = Buffer.from(issuer.raw);
    changed.write('ROOT', at);
    const newTbs = tlv(0x30, ...tbs.kids!.map((k, i) => (i === issuerIndex ? changed : k.raw)));
    const signature = sign('sha256', newTbs, createPrivateKey(made.rootKey));
    return new X509Certificate(
      pemOf(tlv(0x30, newTbs, cert.kids![1]!.raw, tlv(0x03, Buffer.from([0]), signature)))
    );
  }
  const inspectWith = (trust: { anchors: string[]; system: boolean }, certPems: string[]) =>
    inspectMaterial({ source: 'operator', keyPem: made.leafKey, certPems, trust, names: [] });

  it('really differs in case, as the fixture intends', () => {
    const root = recased();
    expect(root.subject).toBe('CN=Root');
    expect(root.issuer).toBe('CN=ROOT');
  });

  it('is its own root when it is trusted: the chain is valid, not incomplete', () => {
    const root = recased();
    expect(
      inspectWith({ anchors: [root.toString()], system: false }, [made.leafPem])
    ).toMatchObject({
      class: 'valid',
      reasons: []
    });
  });

  it('is an untrusted root, not an incomplete chain, when nothing trusts it', () => {
    const root = recased();
    expect(
      inspectWith({ anchors: [], system: false }, [made.leafPem, root.toString()])
    ).toMatchObject({ class: 'degraded-untrusted', reasons: ['untrusted'] });
  });
});
