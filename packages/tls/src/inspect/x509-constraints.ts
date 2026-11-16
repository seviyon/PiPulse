import type { X509Certificate } from 'node:crypto';

/**
 * The two certificate extensions Node's X509Certificate does not expose: basicConstraints'
 * path length and nameConstraints. Read straight from the DER, for certificates Node has
 * already parsed. A client enforces what OpenSSL accepts, and OpenSSL accepts encodings this
 * reader cannot follow (BER lengths, a bad subtree): an extension that is present but cannot be
 * read comes back as 'unreadable', which the caller degrades the chain for. It is never read as
 * "no constraint", and never a reason to refuse.
 */

/** An extension that is there but whose encoding this reader cannot follow. */
export type Unreadable = 'unreadable';

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

/** The items inside `parent`, or undefined when one of them is malformed (so the rest cannot be trusted). */
function children(buf: Buffer, parent: Tlv): Tlv[] | undefined {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end;) {
    const item = tlv(buf, at, parent.end);
    if (!item) return undefined;
    out.push(item);
    at = item.end;
  }
  return out;
}

/**
 * The value (inside its OCTET STRING) of the extension with this OID (hex): undefined when the
 * certificate has none, 'unreadable' when the certificate cannot be walked, or the extension is
 * listed twice or does not fill its OCTET STRING exactly.
 */
function extension(der: Buffer, oidHex: string): Tlv | Unreadable | undefined {
  const cert = tlv(der, 0, der.length);
  const parts = cert && children(der, cert);
  const tbs = parts && parts[0];
  const tbsParts = tbs && children(der, tbs);
  if (!tbsParts) return 'unreadable';
  const wrapper = tbsParts.find((item) => item.tag === 0xa3);
  if (!wrapper) return undefined; // a version 1 certificate: no extensions
  const wrapped = children(der, wrapper);
  const list = wrapped && wrapped[0];
  const extensions = list && children(der, list);
  if (!extensions) return 'unreadable';
  let found: Tlv | undefined;
  for (const ext of extensions) {
    const kids = children(der, ext);
    if (!kids) return 'unreadable';
    const [oid, second, third] = kids;
    if (!oid || oid.tag !== 0x06 || der.toString('hex', oid.start, oid.end) !== oidHex) continue;
    if (found) return 'unreadable'; // twice: OpenSSL refuses it, a reader would pick one
    const octets = second?.tag === 0x04 ? second : third; // a critical flag may sit between
    if (octets?.tag !== 0x04) return 'unreadable';
    const inner = tlv(der, octets.start, octets.end);
    if (!inner || inner.end !== octets.end) return 'unreadable';
    found = inner;
  }
  return found;
}

/** basicConstraints' pathLenConstraint: undefined when there is none, 'unreadable' when it cannot be read. */
export function pathLength(cert: X509Certificate): number | Unreadable | undefined {
  const der = cert.raw;
  const value = extension(der, OID_BASIC_CONSTRAINTS);
  if (value === undefined) return undefined;
  if (value === 'unreadable' || value.tag !== 0x30) return 'unreadable';
  const kids = children(der, value);
  if (!kids) return 'unreadable';
  const integer = kids.find((item) => item.tag === 0x02);
  if (!integer) return undefined;
  const size = integer.end - integer.start;
  if (size > 0 && (der[integer.start]! & 0x80) !== 0) return 'unreadable'; // negative
  if (size > 2) return undefined;
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

/** nameConstraints: undefined when the certificate has none, 'unreadable' when it cannot be read. */
export function nameConstraints(cert: X509Certificate): NameConstraints | Unreadable | undefined {
  const der = cert.raw;
  const value = extension(der, OID_NAME_CONSTRAINTS);
  if (value === undefined) return undefined;
  if (value === 'unreadable' || value.tag !== 0x30) return 'unreadable';
  const result: NameConstraints = {
    permitted: { dns: [], ip: [] },
    excluded: { dns: [], ip: [] }
  };
  const groups = children(der, value);
  if (!groups) return 'unreadable';
  for (const group of groups) {
    // [0] permittedSubtrees, [1] excludedSubtrees
    const target =
      group.tag === 0xa0 ? result.permitted : group.tag === 0xa1 ? result.excluded : undefined;
    const subtrees = target && children(der, group);
    if (!target || !subtrees) return 'unreadable';
    for (const subtree of subtrees) {
      const kids = children(der, subtree);
      const base = kids && kids[0];
      if (!base) return 'unreadable';
      if (base.tag === 0x82) {
        target.dns.push(der.toString('latin1', base.start, base.end).toLowerCase());
      } else if (base.tag === 0x87) {
        const length = base.end - base.start;
        if (length !== 8 && length !== 32) return 'unreadable'; // OpenSSL treats it as a violation
        const half = length / 2;
        target.ip.push({
          address: der.subarray(base.start, base.start + half),
          mask: der.subarray(base.start + half, base.end)
        });
      }
      // Other name types (email, URI, directory name) are not checked, by design.
    }
  }
  return result;
}

export interface LeafNames {
  dns: string[];
  ip: Buffer[];
  /** The subjectAltName could not be read, so its names are not known. */
  unreadable?: boolean;
}

/** The DNS names and IP addresses in the certificate's subjectAltName. */
export function leafNames(cert: X509Certificate): LeafNames {
  const der = cert.raw;
  const out: LeafNames = { dns: [], ip: [] };
  const value = extension(der, OID_SUBJECT_ALT_NAME);
  if (!value) return out;
  const names = value === 'unreadable' || value.tag !== 0x30 ? undefined : children(der, value);
  if (!names) return { ...out, unreadable: true };
  for (const name of names) {
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
 * Whether a wildcard `*.base` can expand to exactly the excluded name `constraint`: a name one
 * label below the base. (A leading-dot constraint such as `.bad.example.test` has a dot left
 * once the base is taken off, so it never matches: it leaves the name itself alone.)
 */
function wildcardReaches(base: string, constraint: string): boolean {
  const suffix = `.${base}`;
  return constraint.endsWith(suffix) && !constraint.slice(0, -suffix.length).includes('.');
}

/**
 * Whether a leaf's names satisfy one CA's name constraints. A wildcard is checked as a name one
 * label below it (what a client would match it against), and against an excluded name it could
 * expand to. Types with no constraint are free. Names that could not be read cannot be shown to
 * satisfy a constraint on their type.
 */
export function violatesNameConstraints(names: LeafNames, constraints: NameConstraints): boolean {
  if (names.unreadable) {
    const { permitted, excluded } = constraints;
    return [permitted, excluded].some((subtrees) => subtrees.dns.length + subtrees.ip.length > 0);
  }
  for (const raw of names.dns) {
    const wildcard = raw.startsWith('*.');
    const name = wildcard ? `x.${raw.slice(2)}` : raw;
    if (
      constraints.excluded.dns.some(
        (c) => dnsInSubtree(name, c) || (wildcard && wildcardReaches(raw.slice(2), c))
      )
    )
      return true;
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
