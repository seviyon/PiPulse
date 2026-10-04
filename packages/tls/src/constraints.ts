import { isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { domainToASCII } from 'node:url';
import type { IssueScope } from './issue.js';

export class ConstraintError extends Error {
  override name = 'ConstraintError';
}

/**
 * What a generated CA may issue for, fixed for its lifetime. `dns` names are
 * permitted with everything below them (RFC 5280); `excludedDns` takes back
 * the names below single-label ones (a Pi called "io" must not be able to
 * vouch for evil.io). `subnets` are only ranges the operator accepted; the
 * loopback ranges in FIXED_IP_RANGES are always permitted and, because a CA
 * permits some IP range, every other IP is refused.
 */
export interface Constraints {
  dns: string[];
  excludedDns: string[];
  subnets: string[];
}

export const FIXED_IP_RANGES = ['127.0.0.1/32', '::1/128'];
/** Container bridges and VPNs: never proposed as the LAN. */
export const SKIPPED_INTERFACE = /^(docker|br-|veth|tun|wg)/;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const printable = (raw: string) => JSON.stringify(raw.length > 64 ? `${raw.slice(0, 64)}…` : raw);
const unique = <T>(values: T[]) => [...new Set(values)];

export function canonicalName(raw: string): string {
  const text = raw.trim().toLowerCase().replace(/\.$/, '');
  // domainToASCII silently drops tabs and newlines ("a\nb" → "ab"): refuse them first.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\s\x00-\x1f\x7f]/.test(text))
    throw new ConstraintError(`${printable(raw)} is not a valid host name`);
  const ascii = /^[\x21-\x7e]*$/.test(text) ? text : domainToASCII(text);
  if (!DNS_NAME.test(ascii) || isIP(ascii) !== 0) {
    throw new ConstraintError(`${printable(raw)} is not a valid host name`);
  }
  return ascii;
}

export interface Address {
  family: 4 | 6;
  bytes: Uint8Array;
}

function parse6(text: string): Uint8Array | undefined {
  if (!/^[0-9a-f:]+$/.test(text)) return undefined; // no dotted IPv4 tail, no %zone
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...tail].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes = new Uint8Array(16);
  all.forEach((group, i) => {
    const value = parseInt(group, 16);
    bytes[2 * i] = value >> 8;
    bytes[2 * i + 1] = value & 0xff;
  });
  return bytes;
}

export function parseAddress(text: string): Address {
  const t = text.trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
    const parts = t.split('.');
    // Leading zeros read as octal in some tools: refuse rather than guess.
    if (parts.some((part) => Number(part) > 255 || (part.length > 1 && part.startsWith('0')))) {
      throw new ConstraintError(`${printable(text)} is not an IPv4 address`);
    }
    return { family: 4, bytes: Uint8Array.from(parts.map(Number)) };
  }
  const bytes = parse6(t);
  if (!bytes) throw new ConstraintError(`${printable(text)} is not an IP address`);
  return { family: 6, bytes };
}

/** Dotted IPv4; IPv6 lower-case with the longest run of two or more zero groups as "::". */
export function formatAddress(address: Address): string {
  if (address.family === 4) return [...address.bytes].join('.');
  const groups = Array.from(
    { length: 8 },
    (_, i) => (address.bytes[2 * i]! << 8) | address.bytes[2 * i + 1]!
  );
  let best = { at: -1, length: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.length) best = { at: i, length: j - i };
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (best.length < 2) return hex.join(':');
  return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.length).join(':')}`;
}

export interface Cidr {
  address: Address;
  prefix: number;
  text: string;
}

function masked(address: Address, prefix: number): Address {
  const bytes = address.bytes.slice();
  for (let i = 0; i < bytes.length; i++) {
    const keep = Math.max(0, Math.min(8, prefix - i * 8));
    bytes[i] = bytes[i]! & ((0xff << (8 - keep)) & 0xff);
  }
  return { family: address.family, bytes };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

export function parseCidr(text: string): Cidr {
  const [addressText, prefixText, extra] = text.trim().split('/');
  if (
    addressText === undefined ||
    prefixText === undefined ||
    extra !== undefined ||
    !/^\d{1,3}$/.test(prefixText)
  ) {
    throw new ConstraintError(`${printable(text)} is not a subnet like 192.168.1.0/24`);
  }
  const address = parseAddress(addressText);
  const prefix = Number(prefixText);
  if (prefix > (address.family === 4 ? 32 : 128))
    throw new ConstraintError(`${printable(text)} has a prefix that is too long`);
  const network = masked(address, prefix);
  if (!sameBytes(network.bytes, address.bytes)) {
    throw new ConstraintError(
      `${text.trim()} has host bits set; use ${formatAddress(network)}/${prefix}`
    );
  }
  return { address: network, prefix, text: `${formatAddress(network)}/${prefix}` };
}

export function contains(cidr: Cidr, address: Address): boolean {
  return (
    address.family === cidr.address.family &&
    sameBytes(masked(address, cidr.prefix).bytes, cidr.address.bytes)
  );
}

const overlaps = (a: Cidr, b: Cidr) => contains(a, b.address) || contains(b, a.address);

const REJECTED: [Cidr, string][] = (
  [
    ['0.0.0.0/8', 'unspecified'],
    ['127.0.0.0/8', 'loopback'],
    ['169.254.0.0/16', 'link-local'],
    ['224.0.0.0/4', 'multicast'],
    ['240.0.0.0/4', 'reserved or broadcast'],
    ['::/128', 'unspecified'],
    ['::1/128', 'loopback'],
    ['fe80::/10', 'link-local'],
    ['ff00::/8', 'multicast'],
    ['::ffff:0:0/96', 'IPv4-mapped'],
    ['64:ff9b::/96', 'NAT64'],
    ['::/96', 'IPv4-compatible']
  ] as const
).map(([text, why]): [Cidr, string] => [parseCidr(text), why]);

/** A subnet the operator may accept: at most a /16 (IPv4) or /48 (IPv6), and a real LAN range. */
export function checkSubnet(text: string): Cidr {
  const cidr = parseCidr(text);
  const min = cidr.address.family === 4 ? 16 : 48;
  if (cidr.prefix < min) {
    throw new ConstraintError(
      `${cidr.text} is broader than /${min}; name a smaller subnet (normally your LAN's /24)`
    );
  }
  for (const [bad, why] of REJECTED) {
    if (overlaps(cidr, bad))
      throw new ConstraintError(`${cidr.text} is ${why} address space, not a LAN`);
  }
  return cidr;
}

/**
 * D2: whether a new CA excludes the names below single-label names
 * (`excluded;DNS:.io`), so a host called "io" can't vouch for evil.io. It
 * changes every new CA's scope for good, so it stays off until the browser
 * results in the plan's Task 1 Step 7b show Chrome, Firefox and Safari
 * accept `io` and refuse `x.io` under such a CA.
 */
export const EXCLUDE_BELOW_SINGLE_LABEL = false;

export function buildConstraints(
  input: { hostname: string; names: string[]; subnets: string[] },
  options: { excludeBelowSingleLabel?: boolean } = {}
): {
  constraints: Constraints;
  warnings: string[];
} {
  const exclude = options.excludeBelowSingleLabel ?? EXCLUDE_BELOW_SINGLE_LABEL;
  const warnings: string[] = [];
  const host = canonicalName(input.hostname);
  const extra: string[] = [];
  for (const name of input.names) {
    if (isIP(name.trim()) !== 0) {
      warnings.push(
        `PIPULSE_TLS_NAMES: ${name.trim()} is an address, not a name, so the CA ignores it; allow IP access with --subnet (a certificate names an address only when an accepted subnet covers it)`
      );
    } else extra.push(canonicalName(name));
  }
  const dns = unique([host, `${host}.local`, 'localhost', ...extra]);
  return {
    constraints: {
      dns,
      excludedDns: exclude
        ? dns.filter((name) => !name.includes('.')).map((name) => `.${name}`)
        : [],
      subnets: unique(input.subnets.map((subnet) => checkSubnet(subnet).text))
    },
    warnings
  };
}

const stringList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConstraintError(`constraints: ${field} must be a list of strings`);
  }
  return value as string[];
};

/** Constraints read back from constraints.json / ca-meta.json: every value re-validated. */
export function parseConstraints(value: unknown): Constraints {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ConstraintError('constraints must be an object');
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find(
    (key) => !['dns', 'excludedDns', 'subnets'].includes(key)
  );
  if (unknownKey) throw new ConstraintError(`constraints: unknown key ${unknownKey}`);
  const dns = stringList(record['dns'], 'dns');
  const excludedDns = stringList(record['excludedDns'], 'excludedDns');
  const subnets = stringList(record['subnets'], 'subnets');
  for (const name of dns)
    if (canonicalName(name) !== name)
      throw new ConstraintError(`constraints: ${printable(name)} is not canonical`);
  for (const name of excludedDns) {
    if (!name.startsWith('.') || canonicalName(name.slice(1)) !== name.slice(1))
      throw new ConstraintError(`constraints: bad exclusion ${printable(name)}`);
  }
  for (const subnet of subnets)
    if (checkSubnet(subnet).text !== subnet)
      throw new ConstraintError(`constraints: ${printable(subnet)} is not canonical`);
  if (dns.length === 0) throw new ConstraintError('constraints: no DNS names');
  return { dns, excludedDns, subnets };
}

export function scopeOf(constraints: Constraints): IssueScope {
  return {
    dns: constraints.dns,
    excludedDns: constraints.excludedDns,
    ip: [...FIXED_IP_RANGES, ...constraints.subnets].map((text) => {
      const cidr = parseCidr(text);
      return { address: formatAddress(cidr.address), prefix: cidr.prefix };
    })
  };
}

export function coversName(constraints: Constraints, name: string): boolean {
  const n = name.toLowerCase();
  const permitted = constraints.dns.some((d) => n === d || n.endsWith(`.${d}`));
  const excluded = constraints.excludedDns.some((e) => n.endsWith(e));
  return permitted && !excluded;
}

export function coversAddress(constraints: Constraints, text: string): boolean {
  let address: Address;
  try {
    address = parseAddress(text);
  } catch {
    return false;
  }
  return [...FIXED_IP_RANGES, ...constraints.subnets].some((range) =>
    contains(parseCidr(range), address)
  );
}

/** The interfaces holding the default routes, from /proc/net/route and /proc/net/ipv6_route. */
export function defaultRouteInterfaces(route4 = '', route6 = ''): { v4?: string; v6?: string } {
  let v4: { iface: string; metric: number } | undefined;
  for (const line of route4.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const [iface, destination, , flags, , , metric, mask] = f;
    const flagBits = parseInt(flags!, 16);
    // RTF_UP set and RTF_REJECT (0x200) clear, as for IPv6 below: a blackhole route is no way out.
    if (
      destination === '00000000' &&
      mask === '00000000' &&
      (flagBits & 0x1) === 1 &&
      (flagBits & 0x200) === 0
    ) {
      const m = Number(metric);
      if (!v4 || m < v4.metric) v4 = { iface: iface!, metric: m };
    }
  }
  let v6: { iface: string; metric: number } | undefined;
  for (const line of route6.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [destination, prefix, , , , metric, , , flags, iface] = f;
    const flagBits = parseInt(flags!, 16);
    // RTF_UP set, RTF_REJECT (0x200) clear, and never the loopback's own routes.
    if (
      /^0{32}$/.test(destination!) &&
      prefix === '00' &&
      iface !== 'lo' &&
      (flagBits & 0x1) === 1 &&
      (flagBits & 0x200) === 0
    ) {
      const m = parseInt(metric!, 16);
      if (!v6 || m < v6.metric) v6 = { iface: iface!, metric: m };
    }
  }
  return { ...(v4 ? { v4: v4.iface } : {}), ...(v6 ? { v6: v6.iface } : {}) };
}

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;
const LINK_LOCAL_6 = parseCidr('fe80::/10');

/** Addresses on the default-route interface(s): the only ones a leaf may name. */
export function defaultRouteAddresses(
  route: { v4?: string; v6?: string },
  interfaces: Interfaces
): string[] {
  const found: string[] = [];
  const usable = (iface?: string) => (iface && !SKIPPED_INTERFACE.test(iface) ? iface : undefined);
  const [v4, v6] = [usable(route.v4), usable(route.v6)];
  for (const info of v4 ? (interfaces[v4] ?? []) : []) {
    if (info.family === 'IPv4' && !info.internal)
      found.push(formatAddress(parseAddress(info.address)));
  }
  for (const info of v6 ? (interfaces[v6] ?? []) : []) {
    if (info.family !== 'IPv6' || info.internal) continue;
    const address = parseAddress(info.address.split('%')[0]!);
    if (!contains(LINK_LOCAL_6, address)) found.push(formatAddress(address));
  }
  return unique(found);
}

/** The subnet the installer may offer: the default-route interface's IPv4 network. */
export function candidateSubnet(
  route: { v4?: string; v6?: string },
  interfaces: Interfaces
): { iface: string; cidr: string } | undefined {
  if (!route.v4 || SKIPPED_INTERFACE.test(route.v4)) return undefined;
  const info = (interfaces[route.v4] ?? []).find((i) => i.family === 'IPv4' && !i.internal);
  if (!info?.cidr) return undefined;
  const [address, prefix] = info.cidr.split('/');
  try {
    const network = masked(parseAddress(address!), Number(prefix));
    return { iface: route.v4, cidr: checkSubnet(`${formatAddress(network)}/${prefix}`).text };
  } catch {
    return undefined;
  }
}

/** A subnet the operator named explicitly that belongs to a bridge or VPN: accepted, with this warning. */
export function subnetWarning(cidrText: string, interfaces: Interfaces): string | undefined {
  const cidr = parseCidr(cidrText);
  for (const [name, infos] of Object.entries(interfaces)) {
    if (!SKIPPED_INTERFACE.test(name)) continue;
    for (const info of infos ?? []) {
      let address: Address;
      try {
        address = parseAddress(info.address.split('%')[0]!);
      } catch {
        continue;
      }
      if (contains(cidr, address)) {
        return `${cidr.text} is the network of ${name} (a container bridge or VPN); accepted because you named it`;
      }
    }
  }
  return undefined;
}

/**
 * The names a new leaf carries: the host, host.local, localhost and
 * PIPULSE_TLS_NAMES that the CA covers, loopback, and the default-route
 * addresses inside accepted subnets. `outside` lists what was left out: names
 * always, addresses only when the CA has a subnet at all (a names-only CA
 * leaving the LAN address out is the expected case, not news).
 */
export function leafNames(input: {
  constraints: Constraints;
  hostname: string;
  names: string[];
  addresses: string[];
}): {
  dns: string[];
  ip: string[];
  outside: string[];
} {
  const dns: string[] = [];
  const ip = ['127.0.0.1', '::1'];
  const outside: string[] = [];
  const addAddress = (text: string, report: boolean) => {
    let canonical: string;
    try {
      canonical = formatAddress(parseAddress(text));
    } catch {
      outside.push(text);
      return;
    }
    if (coversAddress(input.constraints, canonical)) {
      if (!ip.includes(canonical)) ip.push(canonical);
    } else if (report && !outside.includes(canonical)) outside.push(canonical);
  };
  for (const raw of [input.hostname, `${input.hostname}.local`, 'localhost', ...input.names]) {
    if (isIP(raw.trim()) !== 0) {
      addAddress(raw.trim(), true);
      continue;
    }
    let name: string;
    try {
      name = canonicalName(raw);
    } catch {
      outside.push(raw.trim());
      continue;
    }
    if (coversName(input.constraints, name)) {
      if (!dns.includes(name)) dns.push(name);
    } else if (!outside.includes(name)) outside.push(name);
  }
  for (const address of input.addresses) addAddress(address, input.constraints.subnets.length > 0);
  return { dns, ip, outside };
}

/** The spec's consequence text, shown before a subnet is accepted and by `status`. */
export function consequenceText(constraints: Constraints): string[] {
  const below = constraints.excludedDns.map((name) => name.slice(1));
  const lines = [
    'This CA will be trusted for the following DNS names and IP ranges. Anyone holding its private key can impersonate hosts within those ranges.',
    `  DNS: ${constraints.dns.join(', ')} (and names below them${below.length ? `, except below ${below.join(', ')}` : ''})`,
    `  IP:  ${[...FIXED_IP_RANGES, ...constraints.subnets].join(', ')}`
  ];
  for (const subnet of constraints.subnets) {
    lines.push(
      `Accepting ${subnet} allows this CA to issue certificates for any IP in that subnet. A stolen CA key could impersonate other devices there.`
    );
  }
  return lines;
}
