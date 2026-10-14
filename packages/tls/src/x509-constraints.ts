import type { X509Certificate } from 'node:crypto';

/**
 * The two certificate extensions Node's X509Certificate does not expose: basicConstraints'
 * path length and nameConstraints. Read straight from the DER, for certificates Node has
 * already parsed (so only the shapes that matter are handled; anything unexpected reads as
 * "no constraint", never as a reason to refuse).
 */

const OID_BASIC_CONSTRAINTS = '551d13';
const OID_NAME_CONSTRAINTS = '551d1e';
const OID_SUBJECT_ALT_NAME = '551d11';

interface Tlv {
  tag: number;
  /** Where the content starts and ends. */
  start: number;
  end: number;
}

/** One tag-length-value at `at`; undefined when it runs past `limit`. */
function tlv(buf: Buffer, at: number, limit: number): Tlv | undefined {
  if (at + 2 > limit) return undefined;
  const tag = buf[at]!;
  let length = buf[at + 1]!;
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) return undefined;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[start + i]!;
    start += count;
  }
  const end = start + length;
  return end <= limit ? { tag, start, end } : undefined;
}

function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end;) {
    const item = tlv(buf, at, parent.end);
    if (!item) return out;
    out.push(item);
    at = item.end;
  }
  return out;
}

/** The value (inside its OCTET STRING) of the extension with this OID (hex), if the certificate has it. */
function extension(der: Buffer, oidHex: string): Tlv | undefined {
  const cert = tlv(der, 0, der.length);
  const tbs = cert && children(der, cert)[0];
  if (!tbs) return undefined;
  const wrapper = children(der, tbs).find((item) => item.tag === 0xa3);
  const list = wrapper && children(der, wrapper)[0];
  if (!list) return undefined;
  for (const ext of children(der, list)) {
    const [oid, second, third] = children(der, ext);
    if (!oid || oid.tag !== 0x06 || der.toString('hex', oid.start, oid.end) !== oidHex) continue;
    const octets = second?.tag === 0x04 ? second : third; // a critical flag may sit between
    if (octets?.tag !== 0x04) return undefined;
    return tlv(der, octets.start, octets.end);
  }
  return undefined;
}

/** basicConstraints' pathLenConstraint, or undefined when there is none. */
export function pathLength(cert: X509Certificate): number | undefined {
  const der = cert.raw;
  const value = extension(der, OID_BASIC_CONSTRAINTS);
  if (!value) return undefined;
  const integer = children(der, value).find((item) => item.tag === 0x02);
  if (!integer || integer.end - integer.start > 2) return undefined;
  let n = 0;
  for (let i = integer.start; i < integer.end; i++) n = n * 256 + der[i]!;
  return n;
}

export interface Subtrees {
  dns: string[];
  /** Address and mask bytes, 4+4 (IPv4) or 16+16 (IPv6). */
  ip: { address: Buffer; mask: Buffer }[];
}
export interface NameConstraints {
  permitted: Subtrees;
  excluded: Subtrees;
}

/** nameConstraints, or undefined when the certificate has none. */
export function nameConstraints(cert: X509Certificate): NameConstraints | undefined {
  const der = cert.raw;
  const value = extension(der, OID_NAME_CONSTRAINTS);
  if (!value) return undefined;
  const result: NameConstraints = {
    permitted: { dns: [], ip: [] },
    excluded: { dns: [], ip: [] }
  };
  for (const group of children(der, { tag: 0x30, start: value.start, end: value.end })) {
    // [0] permittedSubtrees, [1] excludedSubtrees
    const target =
      group.tag === 0xa0 ? result.permitted : group.tag === 0xa1 ? result.excluded : undefined;
    if (!target) continue;
    for (const subtree of children(der, group)) {
      const base = children(der, subtree)[0];
      if (!base) continue;
      if (base.tag === 0x82) {
        target.dns.push(der.toString('latin1', base.start, base.end).toLowerCase());
      } else if (base.tag === 0x87) {
        const length = base.end - base.start;
        if (length === 8 || length === 32) {
          const half = length / 2;
          target.ip.push({
            address: der.subarray(base.start, base.start + half),
            mask: der.subarray(base.start + half, base.end)
          });
        }
      }
    }
  }
  return result;
}

export interface LeafNames {
  dns: string[];
  ip: Buffer[];
}

/** The DNS names and IP addresses in the certificate's subjectAltName. */
export function leafNames(cert: X509Certificate): LeafNames {
  const der = cert.raw;
  const out: LeafNames = { dns: [], ip: [] };
  const value = extension(der, OID_SUBJECT_ALT_NAME);
  if (!value) return out;
  for (const name of children(der, { tag: 0x30, start: value.start, end: value.end })) {
    if (name.tag === 0x82) out.dns.push(der.toString('latin1', name.start, name.end).toLowerCase());
    else if (name.tag === 0x87 && (name.end - name.start === 4 || name.end - name.start === 16))
      out.ip.push(Buffer.from(der.subarray(name.start, name.end)));
  }
  return out;
}

/** RFC 5280 dNSName matching: the constraint covers itself and everything below it. */
export function dnsInSubtree(name: string, constraint: string): boolean {
  const host = name.replace(/\.$/, '');
  if (constraint === '') return true;
  if (constraint.startsWith('.')) return host.endsWith(constraint);
  return host === constraint || host.endsWith(`.${constraint}`);
}

export function ipInSubtree(address: Buffer, subtree: { address: Buffer; mask: Buffer }): boolean {
  if (address.length !== subtree.address.length) return false;
  for (let i = 0; i < address.length; i++) {
    if ((address[i]! & subtree.mask[i]!) !== (subtree.address[i]! & subtree.mask[i]!)) return false;
  }
  return true;
}

/**
 * Whether a leaf's names satisfy one CA's name constraints. A wildcard is checked as a name one
 * label below it (what a client would match it against). Types with no constraint are free.
 */
export function violatesNameConstraints(names: LeafNames, constraints: NameConstraints): boolean {
  for (const raw of names.dns) {
    const name = raw.startsWith('*.') ? `x.${raw.slice(2)}` : raw;
    if (constraints.excluded.dns.some((c) => dnsInSubtree(name, c))) return true;
    if (
      constraints.permitted.dns.length > 0 &&
      !constraints.permitted.dns.some((c) => dnsInSubtree(name, c))
    )
      return true;
  }
  for (const address of names.ip) {
    if (constraints.excluded.ip.some((c) => ipInSubtree(address, c))) return true;
    if (
      constraints.permitted.ip.length > 0 &&
      !constraints.permitted.ip.some((c) => ipInSubtree(address, c))
    )
      return true;
  }
  return false;
}
