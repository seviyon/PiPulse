import type { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ipInSubtree,
  leafNames,
  nameConstraints,
  pathLength,
  violatesNameConstraints
} from '../../src/inspect/x509-constraints.js';

// The reader's edges, pinned with hand-built DER: each case is one the mutation run showed no
// other test would notice changing. A certificate here is only what the reader walks through.

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag, body.length]), body]);
};
/** A TLV whose length is written in long form with exactly `width` bytes. */
const wide = (tag: number, width: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const length = Buffer.alloc(width);
  length.writeUIntBE(body.length, 0, width);
  return Buffer.concat([Buffer.from([tag, 0x80 | width]), length, body]);
};
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
const extension = (oidHex: string, value: Buffer, critical = false) =>
  der(0x30, oid(oidHex), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
const withParts = (...extensions: Buffer[]): X509Certificate =>
  ({
    raw: der(0x30, der(0x30, der(0xa3, der(0x30, ...extensions))))
  }) as unknown as X509Certificate;

const BASIC = '551d13';
const NAME_CONSTRAINTS = '551d1e';
const SAN = '551d11';
const basic = (...items: Buffer[]) => extension(BASIC, der(0x30, ...items));
const integer = (...bytes: number[]) => der(0x02, Buffer.from(bytes));

describe('long-form lengths', () => {
  it('accepts a four-byte length, and refuses a five-byte one', () => {
    const four = extension(BASIC, wide(0x30, 4, integer(5)));
    expect(pathLength(withParts(four))).toBe(5);
    const five = extension(BASIC, wide(0x30, 5, integer(5)));
    expect(pathLength(withParts(five))).toBe('unreadable');
  });

  it('accepts a long-form length that ends exactly where its parent does', () => {
    // 30 03 | 30 81 00: an empty (non-DER) tbs whose length byte is the last byte
    const cert = { raw: Buffer.from([0x30, 0x03, 0x30, 0x81, 0x00]) } as unknown as X509Certificate;
    expect(pathLength(cert)).toBeUndefined();
  });
});

describe('walking the extensions', () => {
  it('reads an extension list with an empty entry in it, and skips one whose first part is not an OID', () => {
    expect(pathLength(withParts(der(0x30), basic(integer(2))))).toBe(2);
    const impostor = der(
      0x30,
      der(0x04, Buffer.from(BASIC, 'hex')),
      der(0x04, der(0x30, integer(5)))
    );
    expect(pathLength(withParts(impostor))).toBeUndefined();
  });

  it('reads a list whose entries are malformed as unreadable', () => {
    const brokenList = {
      raw: der(0x30, der(0x30, der(0xa3, der(0x30, Buffer.from([0x04, 0x09])))))
    };
    expect(pathLength(brokenList as unknown as X509Certificate)).toBe('unreadable');
    const brokenEntry = der(0x30, Buffer.from([0x04, 0x09]));
    expect(pathLength(withParts(brokenEntry))).toBe('unreadable');
  });

  it('reads an extension that is only an OID as unreadable', () => {
    expect(pathLength(withParts(der(0x30, oid(BASIC))))).toBe('unreadable');
  });

  it('reads an extension value that is not a SEQUENCE as unreadable, for all three extensions', () => {
    // What is inside would read fine if the tag were a SEQUENCE's.
    const notSequence = (oidHex: string, inside: Buffer) => extension(oidHex, der(0x04, inside));
    const group = der(0xa0, der(0x30, der(0x82, Buffer.from('x.test'))));
    expect(pathLength(withParts(notSequence(BASIC, integer(5))))).toBe('unreadable');
    expect(nameConstraints(withParts(notSequence(NAME_CONSTRAINTS, group)))).toBe('unreadable');
    expect(leafNames(withParts(notSequence(SAN, der(0x82, Buffer.from('a.test')))))).toEqual({
      dns: [],
      ip: [],
      unreadable: true
    });
  });

  it('reads values whose inside is malformed as unreadable', () => {
    const malformed = Buffer.from([0x30, 0x02, 0x02, 0x09]);
    expect(pathLength(withParts(extension(BASIC, malformed)))).toBe('unreadable');
    expect(nameConstraints(withParts(extension(NAME_CONSTRAINTS, malformed)))).toBe('unreadable');
    expect(leafNames(withParts(extension(SAN, malformed)))).toEqual({
      dns: [],
      ip: [],
      unreadable: true
    });
    const brokenGroup = extension(
      NAME_CONSTRAINTS,
      der(0x30, der(0xa0, Buffer.from([0x30, 0x09])))
    );
    expect(nameConstraints(withParts(brokenGroup))).toBe('unreadable');
  });
});

describe('pathLenConstraint', () => {
  it('reads an empty INTEGER as 0 even when the next byte has its high bit set', () => {
    const cert = withParts(basic(der(0x02), Buffer.from([0x80, 0x00])));
    expect(pathLength(cert)).toBe(0);
  });

  it('reads a two-byte INTEGER whole', () => {
    expect(pathLength(withParts(basic(integer(0x01, 0x00))))).toBe(256);
    expect(pathLength(withParts(basic(integer(0x00, 0x7f))))).toBe(127);
  });
});

describe('subject alternative names', () => {
  it('leaves out a name of another kind even when it is four or sixteen bytes long', () => {
    const san = extension(
      SAN,
      der(
        0x30,
        der(0x81, Buffer.from('a@bc')),
        der(0x86, Buffer.alloc(16, 1)),
        der(0x87, Buffer.from([1, 2, 3, 4]))
      )
    );
    expect(leafNames(withParts(san)).ip).toEqual([Buffer.from([1, 2, 3, 4])]);
  });
});

describe('matching', () => {
  it('does not match an address against a subtree of the other family', () => {
    const everything = { address: Buffer.alloc(16), mask: Buffer.alloc(16) };
    expect(ipInSubtree(Buffer.from([10, 0, 0, 1]), everything)).toBe(false);
  });

  const none = { dns: [], ip: [] };
  it('accepts a name that is in any one of several permitted subtrees', () => {
    const permitted = { dns: ['a.test', 'b.test'], ip: [] };
    expect(
      violatesNameConstraints({ dns: ['x.b.test'], ip: [] }, { permitted, excluded: none })
    ).toBe(false);
    const permittedIp = {
      dns: [],
      ip: [
        { address: Buffer.from([10, 0, 0, 0]), mask: Buffer.from([255, 0, 0, 0]) },
        { address: Buffer.from([192, 168, 0, 0]), mask: Buffer.from([255, 255, 0, 0]) }
      ]
    };
    expect(
      violatesNameConstraints(
        { dns: [], ip: [Buffer.from([192, 168, 1, 1])] },
        { permitted: permittedIp, excluded: none }
      )
    ).toBe(false);
  });

  it('checks a wildcard as a name one label below it', () => {
    const permitted = { dns: ['x.example.test'], ip: [] };
    expect(
      violatesNameConstraints({ dns: ['*.example.test'], ip: [] }, { permitted, excluded: none })
    ).toBe(false);
  });

  it('counts an address constraint too when the names could not be read', () => {
    const unreadable = { dns: [], ip: [], unreadable: true };
    const address = [{ address: Buffer.from([10, 0, 0, 0]), mask: Buffer.from([255, 0, 0, 0]) }];
    expect(
      violatesNameConstraints(unreadable, { permitted: { dns: [], ip: address }, excluded: none })
    ).toBe(true);
    expect(
      violatesNameConstraints(unreadable, { permitted: none, excluded: { dns: [], ip: address } })
    ).toBe(true);
  });
});

describe('subject alternative names that cannot be read are never "no names"', () => {
  const unreadable = { dns: [], ip: [], unreadable: true };
  const cert = (...extensions: Buffer[]) => leafNames(withParts(...extensions));
  const san = extension(SAN, der(0x30, der(0x82, Buffer.from('a.test'))));

  it('reads the control as its names', () => {
    expect(cert(san)).toEqual({ dns: ['a.test'], ip: [] });
  });

  it('a malformed entry in the extension list', () => {
    expect(cert(san, Buffer.from([0x04, 0x09]))).toEqual(unreadable);
  });

  it('a malformed extension entry', () => {
    expect(cert(der(0x30, Buffer.from([0x04, 0x09])))).toEqual(unreadable);
  });

  it('the extension listed twice', () => {
    expect(cert(san, san)).toEqual(unreadable);
  });

  it('a value that is not an OCTET STRING, or does not fill it', () => {
    expect(cert(der(0x30, oid(SAN), der(0x02, Buffer.from([5]))))).toEqual(unreadable);
    expect(
      cert(
        extension(
          SAN,
          Buffer.concat([der(0x30, der(0x82, Buffer.from('a.test'))), Buffer.from([0])])
        )
      )
    ).toEqual(unreadable);
  });
});
