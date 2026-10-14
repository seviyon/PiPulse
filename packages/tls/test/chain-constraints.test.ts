import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectMaterial } from '../src/inspect.js';
import {
  dnsInSubtree,
  ipInSubtree,
  leafNames,
  nameConstraints,
  pathLength,
  violatesNameConstraints
} from '../src/x509-constraints.js';
import { tempDir } from './helpers.js';
import { TEST_OPENSSL } from './openssl.js';

// Real certificates from OpenSSL: Node cannot make them, and a hand-made DER would only test
// the parser against itself.
let dir: string;
beforeAll(() => {
  dir = tempDir();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const openssl = (...args: string[]) =>
  execFileSync(TEST_OPENSSL, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let counter = 0;

interface Options {
  /** extensions of the root (after CA:TRUE) */
  root?: string;
  /** extensions of the intermediate, one per line */
  intermediate?: string[];
  /** the leaf's subjectAltName, e.g. "DNS:a.example.com,IP:10.1.2.3" */
  san: string;
  /** number of intermediates between root and leaf (default 1) */
  depth?: number;
  rootPathLen?: number;
}

/** root → (intermediates) → leaf, written to the temp folder; returns what inspectMaterial takes. */
function chain(options: Options) {
  const id = `c${++counter}`;
  const f = (name: string) => join(dir, `${id}-${name}`);
  const key = (name: string) =>
    openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f(`${name}.key`));
  const sign = (name: string, issuer: string, subject: string, ext: string[]) => {
    writeFileSync(f(`${name}.ext`), `${ext.join('\n')}\n`);
    openssl(
      'req',
      '-new',
      '-key',
      f(`${name}.key`),
      '-subj',
      `/CN=${subject}`,
      '-out',
      f(`${name}.csr`)
    );
    openssl(
      'x509',
      '-req',
      '-in',
      f(`${name}.csr`),
      '-CA',
      f(`${issuer}.crt`),
      '-CAkey',
      f(`${issuer}.key`),
      '-CAcreateserial',
      '-days',
      '30',
      '-extfile',
      f(`${name}.ext`),
      '-out',
      f(`${name}.crt`)
    );
  };
  key('root');
  const rootBasic = `basicConstraints=critical,CA:TRUE${
    options.rootPathLen === undefined ? '' : `,pathlen:${options.rootPathLen}`
  }`;
  writeFileSync(
    f('root.ext'),
    `${[rootBasic, 'keyUsage=keyCertSign', ...(options.root ? [options.root] : [])].join('\n')}\n`
  );
  openssl(
    'req',
    '-new',
    '-x509',
    '-key',
    f('root.key'),
    '-subj',
    '/CN=Root',
    '-days',
    '30',
    '-extensions',
    'v3_ca',
    '-config',
    writeConfig(f('root.cnf'), f('root.ext')),
    '-out',
    f('root.crt')
  );
  let issuer = 'root';
  const depth = options.depth ?? 1;
  const names: string[] = [];
  for (let i = 0; i < depth; i++) {
    const name = `int${i}`;
    key(name);
    sign(name, issuer, `Int ${i}`, [
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=keyCertSign',
      ...(i === 0 ? (options.intermediate ?? []) : [])
    ]);
    names.unshift(name);
    issuer = name;
  }
  key('leaf');
  sign('leaf', issuer, 'leaf', [`subjectAltName=${options.san}`, 'extendedKeyUsage=serverAuth']);
  const read = (name: string) => readFileSync(f(`${name}.crt`), 'utf8');
  return {
    keyPem: readFileSync(f('leaf.key'), 'utf8'),
    certPems: [read('leaf'), ...names.map(read)],
    rootPem: read('root')
  };
}

/** req -x509 reads its extensions from a config section; this makes one from an extension file. */
function writeConfig(path: string, extFile: string): string {
  const ext = readFileSync(extFile, 'utf8');
  writeFileSync(path, `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Root\n[v3_ca]\n${ext}`);
  return path;
}

const inspect = (made: ReturnType<typeof chain>) =>
  inspectMaterial({
    source: 'operator',
    keyPem: made.keyPem,
    certPems: made.certPems,
    trust: { anchors: [made.rootPem], system: false },
    names: []
  });

describe('path length', () => {
  it('a root with pathlen 0 may not have an intermediate below it', () => {
    const result = inspect(chain({ san: 'DNS:a.test', rootPathLen: 0 }));
    expect(result.class).toBe('degraded-untrusted');
    expect(result.reasons).toContain('path-length');
  });

  it('pathlen 1 allows one intermediate, and 1 does not allow two', () => {
    expect(inspect(chain({ san: 'DNS:a.test', rootPathLen: 1 })).class).toBe('valid');
    const two = inspect(chain({ san: 'DNS:a.test', rootPathLen: 1, depth: 2 }));
    expect(two.reasons).toContain('path-length');
  });

  it('no pathlen means no limit', () => {
    expect(inspect(chain({ san: 'DNS:a.test', depth: 3 })).class).toBe('valid');
  });

  it('pathlen 0 on the intermediate itself is fine for the leaf below it', () => {
    const made = chain({ san: 'DNS:a.test' });
    expect(pathLength(new X509Certificate(made.certPems[1]!))).toBeUndefined();
    expect(pathLength(new X509Certificate(made.rootPem))).toBeUndefined();
  });

  it('reads the number from the certificate', () => {
    expect(
      pathLength(new X509Certificate(chain({ san: 'DNS:a.test', rootPathLen: 3 }).rootPem))
    ).toBe(3);
    expect(
      pathLength(new X509Certificate(chain({ san: 'DNS:a.test', rootPathLen: 0 }).rootPem))
    ).toBe(0);
  });
});

describe('name constraints', () => {
  const permitted = [
    'nameConstraints=critical,permitted;DNS:example.com,permitted;IP:10.0.0.0/255.0.0.0'
  ];

  it('names inside the permitted subtrees pass, wildcards included', () => {
    expect(
      inspect(
        chain({
          san: 'DNS:a.example.com,DNS:example.com,DNS:*.example.com,IP:10.1.2.3',
          intermediate: permitted
        })
      ).class
    ).toBe('valid');
  });

  it('a name outside the permitted DNS subtrees is a violation', () => {
    const result = inspect(
      chain({ san: 'DNS:a.example.com,DNS:other.org', intermediate: permitted })
    );
    expect(result.class).toBe('degraded-untrusted');
    expect(result.reasons).toContain('name-constraint');
  });

  it('a wildcard outside them is too', () => {
    expect(inspect(chain({ san: 'DNS:*.other.org', intermediate: permitted })).reasons).toContain(
      'name-constraint'
    );
  });

  it('an address outside the permitted ranges is a violation', () => {
    expect(
      inspect(chain({ san: 'DNS:a.example.com,IP:192.168.1.1', intermediate: permitted })).reasons
    ).toContain('name-constraint');
  });

  it('excluded subtrees win over permitted ones', () => {
    const excluded = [
      'nameConstraints=critical,permitted;DNS:example.com,excluded;DNS:bad.example.com,excluded;IP:10.9.0.0/255.255.0.0'
    ];
    expect(
      inspect(chain({ san: 'DNS:ok.example.com,IP:10.1.1.1', intermediate: excluded })).class
    ).toBe('valid');
    expect(
      inspect(chain({ san: 'DNS:bad.example.com', intermediate: excluded })).reasons
    ).toContain('name-constraint');
    expect(
      inspect(chain({ san: 'DNS:x.bad.example.com', intermediate: excluded })).reasons
    ).toContain('name-constraint');
    expect(
      inspect(chain({ san: 'DNS:a.example.com,IP:10.9.1.1', intermediate: excluded })).reasons
    ).toContain('name-constraint');
  });

  it('only excluded subtrees: everything else passes', () => {
    const onlyExcluded = ['nameConstraints=critical,excluded;DNS:.lan'];
    expect(inspect(chain({ san: 'DNS:pi.example.com', intermediate: onlyExcluded })).class).toBe(
      'valid'
    );
    expect(inspect(chain({ san: 'DNS:pi.lan', intermediate: onlyExcluded })).reasons).toContain(
      'name-constraint'
    );
  });

  it('a constraint with a leading dot covers the subdomains but not the name itself', () => {
    const dotted = ['nameConstraints=critical,permitted;DNS:.example.com'];
    expect(inspect(chain({ san: 'DNS:a.example.com', intermediate: dotted })).class).toBe('valid');
    expect(inspect(chain({ san: 'DNS:example.com', intermediate: dotted })).reasons).toContain(
      'name-constraint'
    );
  });

  it('an IPv6 range is checked as bytes', () => {
    const v6 = ['nameConstraints=critical,permitted;IP:fd00::/ff00::'];
    expect(inspect(chain({ san: 'IP:fd00::5', intermediate: v6 })).class).toBe('valid');
    expect(inspect(chain({ san: 'IP:2001:db8::1', intermediate: v6 })).reasons).toContain(
      'name-constraint'
    );
    // an IPv4 address is not inside an IPv6 range
    expect(inspect(chain({ san: 'IP:10.0.0.1', intermediate: v6 })).reasons).toContain(
      'name-constraint'
    );
  });

  it('constraints on the root are enforced too', () => {
    const made = chain({
      san: 'DNS:a.other.org',
      root: 'nameConstraints=critical,permitted;DNS:example.com'
    });
    expect(inspect(made).reasons).toContain('name-constraint');
    const fine = chain({
      san: 'DNS:a.example.com',
      root: 'nameConstraints=critical,permitted;DNS:example.com'
    });
    expect(inspect(fine).class).toBe('valid');
  });

  it('a type with no constraint is free (DNS constraints do not touch addresses)', () => {
    expect(
      inspect(
        chain({
          san: 'DNS:a.example.com,IP:192.168.1.1',
          intermediate: ['nameConstraints=critical,permitted;DNS:example.com']
        })
      ).class
    ).toBe('valid');
  });

  it('reads nothing from a certificate without constraints', () => {
    const made = chain({ san: 'DNS:a.test' });
    expect(nameConstraints(new X509Certificate(made.certPems[1]!))).toBeUndefined();
    const read = nameConstraints(
      new X509Certificate(chain({ san: 'DNS:a.test', intermediate: permitted }).certPems[1]!)
    )!;
    expect(read.permitted.dns).toEqual(['example.com']);
    expect(read.permitted.ip).toHaveLength(1);
    expect(read.excluded).toEqual({ dns: [], ip: [] });
  });
});

describe('the leaf’s names', () => {
  it('are read from the DER, DNS lower-cased, addresses as bytes', () => {
    const names = leafNames(
      new X509Certificate(chain({ san: 'DNS:Pi.Example.COM,IP:10.1.2.3,IP:fd00::1' }).certPems[0]!)
    );
    expect(names.dns).toEqual(['pi.example.com']);
    expect(names.ip.map((b) => b.length)).toEqual([4, 16]);
    expect([...names.ip[0]!]).toEqual([10, 1, 2, 3]);
  });

  it('are empty for a certificate with no subjectAltName', () => {
    const made = chain({ san: 'DNS:a.test' });
    expect(leafNames(new X509Certificate(made.rootPem))).toEqual({ dns: [], ip: [] });
  });
});

describe('the subtree matchers', () => {
  it('dnsInSubtree: the name itself and below, label boundaries, trailing dot, empty = everything', () => {
    expect(dnsInSubtree('example.com', 'example.com')).toBe(true);
    expect(dnsInSubtree('a.b.example.com', 'example.com')).toBe(true);
    expect(dnsInSubtree('notexample.com', 'example.com')).toBe(false);
    expect(dnsInSubtree('example.com.', 'example.com')).toBe(true);
    expect(dnsInSubtree('anything', '')).toBe(true);
    expect(dnsInSubtree('example.com', '.example.com')).toBe(false);
    expect(dnsInSubtree('a.example.com', '.example.com')).toBe(true);
  });

  it('ipInSubtree: masks the address, and v4 never matches v6', () => {
    const range = { address: Buffer.from([10, 0, 0, 0]), mask: Buffer.from([255, 0, 0, 0]) };
    expect(ipInSubtree(Buffer.from([10, 9, 9, 9]), range)).toBe(true);
    expect(ipInSubtree(Buffer.from([11, 0, 0, 1]), range)).toBe(false);
    expect(ipInSubtree(Buffer.alloc(16), range)).toBe(false);
  });

  it('violatesNameConstraints with nothing listed never violates', () => {
    const none = { permitted: { dns: [], ip: [] }, excluded: { dns: [], ip: [] } };
    expect(
      violatesNameConstraints({ dns: ['a.test'], ip: [Buffer.from([1, 2, 3, 4])] }, none)
    ).toBe(false);
  });
});

describe('DER the parser does not understand reads as "no constraint"', () => {
  const fake = (bytes: number[]) => ({ raw: Buffer.from(bytes) }) as unknown as X509Certificate;
  const cases: [string, number[]][] = [
    ['empty', []],
    ['a length that runs past the end', [0x30, 0x10, 0x30, 0x00]],
    ['a length of more than four bytes', [0x30, 0x85, 1, 2, 3, 4, 5, 6]],
    ['an indefinite length', [0x30, 0x80, 0x00, 0x00]],
    ['a certificate with an empty body', [0x30, 0x00]],
    ['a tbs with no extensions', [0x30, 0x04, 0x30, 0x02, 0x02, 0x00]],
    ['an empty extensions wrapper', [0x30, 0x06, 0x30, 0x04, 0xa3, 0x02, 0x30, 0x00]]
  ];
  it.each(cases)('%s', (_name, bytes) => {
    expect(pathLength(fake(bytes))).toBeUndefined();
    expect(nameConstraints(fake(bytes))).toBeUndefined();
    expect(leafNames(fake(bytes))).toEqual({ dns: [], ip: [] });
  });
});

describe('odd but well-formed DER', () => {
  const der = (tag: number, ...parts: Buffer[]): Buffer => {
    const body = Buffer.concat(parts);
    if (body.length < 128) return Buffer.concat([Buffer.from([tag, body.length]), body]);
    return Buffer.concat([Buffer.from([tag, 0x81, body.length]), body]);
  };
  const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
  /** A certificate-shaped DER holding just these extensions (what the parser walks through). */
  const withExtension = (...extensions: Buffer[]): X509Certificate =>
    ({
      raw: der(0x30, der(0x30, der(0xa3, der(0x30, ...extensions))))
    }) as unknown as X509Certificate;
  const extension = (oidHex: string, value: Buffer, critical = false) =>
    der(0x30, oid(oidHex), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));

  it('an item that claims more bytes than its parent holds ends the walk quietly', () => {
    const cert = {
      raw: Buffer.from([0x30, 0x04, 0x30, 0x02, 0x04, 0x09])
    } as unknown as X509Certificate;
    expect(pathLength(cert)).toBeUndefined();
  });

  it('an extension whose value is not an OCTET STRING reads as absent', () => {
    const broken = der(0x30, oid('551d13'), der(0x02, Buffer.from([5])));
    expect(pathLength(withExtension(broken))).toBeUndefined();
  });

  it('a pathLen of the critical-flag form is read, and a huge one is ignored', () => {
    const small = extension(
      '551d13',
      der(0x30, der(0x01, Buffer.from([0xff])), der(0x02, Buffer.from([2]))),
      true
    );
    expect(pathLength(withExtension(small))).toBe(2);
    const huge = extension('551d13', der(0x30, der(0x02, Buffer.from([1, 2, 3]))));
    expect(pathLength(withExtension(huge))).toBeUndefined();
    const none = extension('551d13', der(0x30, der(0x01, Buffer.from([0xff]))));
    expect(pathLength(withExtension(none))).toBeUndefined();
  });

  it('name constraints keep DNS and address subtrees and skip the kinds and sizes they do not use', () => {
    const subtree = (base: Buffer) => der(0x30, base);
    const value = der(
      0x30,
      der(0xa5, subtree(der(0x82, Buffer.from('ignored')))), // not permitted/excluded
      der(
        0xa0,
        der(0x30), // a subtree with no base
        subtree(der(0x81, Buffer.from('a@b'))), // an e-mail constraint
        subtree(der(0x87, Buffer.from([1, 2, 3, 4, 5]))), // an address of an odd size
        subtree(der(0x82, Buffer.from('Example.COM')))
      ),
      der(0xa1, subtree(der(0x87, Buffer.from([10, 0, 0, 0, 255, 0, 0, 0]))))
    );
    const read = nameConstraints(withExtension(extension('551d1e', value, true)))!;
    expect(read.permitted).toEqual({ dns: ['example.com'], ip: [] });
    expect(read.excluded.ip).toHaveLength(1);
    expect(read.excluded.dns).toEqual([]);
  });

  it('subject alternative names of other kinds, or addresses of odd sizes, are left out', () => {
    const san = extension(
      '551d11',
      der(
        0x30,
        der(0x81, Buffer.from('a@b')),
        der(0x87, Buffer.from([1, 2, 3])),
        der(0x82, Buffer.from('ok.test'))
      )
    );
    expect(leafNames(withExtension(san))).toEqual({ dns: ['ok.test'], ip: [] });
  });
});
