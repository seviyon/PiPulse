import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { caExtensions } from '../src/issue.js';
import {
  ConstraintError,
  EXCLUDE_BELOW_SINGLE_LABEL,
  buildConstraints,
  candidateSubnet,
  canonicalName,
  checkSubnet,
  consequenceText,
  coversAddress,
  coversName,
  defaultRouteAddresses,
  defaultRouteInterfaces,
  formatAddress,
  leafNames,
  parseAddress,
  parseCidr,
  parseConstraints,
  scopeOf,
  subnetWarning
} from '../src/constraints.js';

const ROUTE4_HEADER =
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
const route4 = (...rows: string[]) => [ROUTE4_HEADER, ...rows].join('\n');
// Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
const DEFAULT_ETH0 = 'eth0\t00000000\t0101A8C0\t0003\t0\t0\t202\t00000000\t0\t0\t0';
const LAN_ETH0 = 'eth0\t0001A8C0\t00000000\t0001\t0\t0\t202\t00FFFFFF\t0\t0\t0';
const DEFAULT_WLAN0 = 'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t303\t00000000\t0\t0\t0';
// A blackhole default route (RTF_UP | RTF_REJECT = 0x0201) with a lower metric than the real one.
const REJECT_DEFAULT = 'eth9\t00000000\t00000000\t0201\t0\t0\t10\t00000000\t0\t0\t0';
const ZERO = '0'.repeat(32);
const route6Default = (iface: string, metric = '00000400', flags = '00450003') =>
  `${ZERO} 00 ${ZERO} 00 fe800000000000000000000000000001 ${metric} 00000001 00000000 ${flags} ${iface}`;

const v4 = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr
});
const v6 = (address: string, cidr: string): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr,
  scopeid: 0
});
const PI = {
  lo: [v4('127.0.0.1', '127.0.0.1/8', true)],
  eth0: [
    v4('192.168.1.35', '192.168.1.35/24'),
    v6('fe80::1', 'fe80::1/64'),
    v6('2001:db8:1:2::35', '2001:db8:1:2::35/64')
  ],
  wlan0: [v4('10.0.0.7', '10.0.0.7/24')],
  docker0: [v4('172.17.0.1', '172.17.0.1/16')],
  wg0: [v4('10.8.0.2', '10.8.0.2/24')]
};

describe('canonicalName', () => {
  it('lower-cases, drops a trailing dot and turns IDNs into punycode', () => {
    expect(canonicalName('Io.')).toBe('io');
    expect(canonicalName(' io.LOCAL ')).toBe('io.local');
    expect(canonicalName('münchen.lan')).toBe('xn--mnchen-3ya.lan');
  });

  it.each([
    'bad name',
    'a,b',
    'a=b',
    'a\nb',
    '$HOME',
    'x'.repeat(64),
    `${'a.'.repeat(127)}a`,
    'a..b',
    '-lead',
    'trail-',
    'under_score',
    '',
    '192.168.1.35',
    '::1'
  ])('refuses %j without quoting more than 64 characters of it', (raw) => {
    expect(() => canonicalName(raw)).toThrow(ConstraintError);
    try {
      canonicalName(raw);
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(140);
    }
  });
});

describe('addresses and subnets', () => {
  it('canonicalises IPv6 per RFC 5952 and refuses odd forms', () => {
    expect(formatAddress(parseAddress('0:0:0:0:0:0:0:1'))).toBe('::1');
    expect(formatAddress(parseAddress('2001:DB8:0:0:1:0:0:1'))).toBe('2001:db8::1:0:0:1');
    expect(formatAddress(parseAddress('fd00:0:0:0:0:0:0:0'))).toBe('fd00::');
    for (const bad of [
      '::ffff:1.2.3.4',
      'fe80::1%eth0',
      '1::2::3',
      '12345::',
      '01.2.3.4',
      '1.2.3.256'
    ]) {
      expect(() => parseAddress(bad)).toThrow(ConstraintError);
    }
  });

  it('keeps a subnet only when its host bits are zero', () => {
    expect(parseCidr('192.168.1.0/24').text).toBe('192.168.1.0/24');
    expect(() => parseCidr('192.168.1.35/24')).toThrow(/use 192.168.1.0\/24/);
    expect(parseCidr('2001:DB8:1::/48').text).toBe('2001:db8:1::/48');
  });

  it.each([
    ['10.0.0.0/8', /broader than \/16/],
    ['0.0.0.0/0', /broader than \/16/],
    ['2001:db8::/32', /broader than \/48/],
    ['::/0', /broader than \/48/],
    ['127.0.0.0/24', /loopback/],
    ['169.254.1.0/24', /link-local/],
    ['224.0.1.0/24', /multicast/],
    ['255.255.255.255/32', /broadcast/],
    ['0.0.0.0/16', /unspecified/],
    ['fe80::/64', /link-local/],
    ['ff02::/64', /multicast/],
    ['::ffff:c0a8:100/120', /IPv4-mapped/],
    ['::c0a8:100/120', /IPv4-compatible/],
    ['64:ff9b::/96', /NAT64/],
    ['::1/128', /loopback/]
  ])('refuses %s', (subnet, reason) => {
    expect(() => checkSubnet(subnet)).toThrow(reason);
  });

  it.each([
    '192.168.1.0/24',
    '10.20.0.0/16',
    '172.16.5.0/24',
    '2001:db8:1::/48',
    'fd12:3456:789a::/64'
  ])('accepts %s', (subnet) => {
    expect(checkSubnet(subnet).text).toBe(subnet);
  });
});

describe('buildConstraints', () => {
  it('permits the host, host.local and localhost; no exclusions with the D2 switch off', () => {
    const { constraints, warnings } = buildConstraints(
      { hostname: 'Io', names: [], subnets: [] },
      { excludeBelowSingleLabel: false }
    );
    expect(constraints).toEqual({
      dns: ['io', 'io.local', 'localhost'],
      excludedDns: [],
      subnets: []
    });
    expect(warnings).toEqual([]);
  });

  it('with the D2 switch on, excludes the names below single-label ones', () => {
    const { constraints } = buildConstraints(
      { hostname: 'Io', names: ['io.lan'], subnets: [] },
      { excludeBelowSingleLabel: true }
    );
    expect(constraints.excludedDns).toEqual(['.io', '.localhost']);
  });

  it('defaults to the switch, which is on since the D2 browser gate passed (Task 1 Step 7b)', () => {
    expect(EXCLUDE_BELOW_SINGLE_LABEL).toBe(true);
    expect(
      buildConstraints({ hostname: 'io', names: [], subnets: [] }).constraints.excludedDns
    ).toEqual(['.io', '.localhost']);
    // A dotted host name has no single-label subtree to exclude except localhost.
    expect(
      buildConstraints({ hostname: 'pi.example', names: [], subnets: [] }).constraints.excludedDns
    ).toEqual(['.localhost']);
  });

  it('adds PIPULSE_TLS_NAMES and accepted subnets, and leaves IP names out with a warning', () => {
    const { constraints, warnings } = buildConstraints({
      hostname: 'io',
      names: ['io.lan', 'IO.LAN', '192.168.1.35'],
      subnets: ['192.168.1.0/24']
    });
    expect(constraints.dns).toEqual(['io', 'io.local', 'localhost', 'io.lan']);
    expect(constraints.subnets).toEqual(['192.168.1.0/24']);
    expect(warnings).toEqual([
      'PIPULSE_TLS_NAMES: 192.168.1.35 is an address, not a name, so the CA ignores it; allow IP access with --subnet (a certificate names an address only when an accepted subnet covers it)'
    ]);
  });

  it('refuses a hostile name or a bad subnet outright', () => {
    expect(() => buildConstraints({ hostname: 'io', names: ['a b'], subnets: [] })).toThrow(
      ConstraintError
    );
    expect(() => buildConstraints({ hostname: 'io', names: [], subnets: ['10.0.0.0/8'] })).toThrow(
      ConstraintError
    );
  });

  it('turns into an issue scope with the fixed loopback ranges first', () => {
    const { constraints } = buildConstraints({
      hostname: 'io',
      names: [],
      subnets: ['192.168.1.0/24']
    });
    expect(scopeOf(constraints).ip).toEqual([
      { address: '127.0.0.1', prefix: 32 },
      { address: '::1', prefix: 128 },
      { address: '192.168.1.0', prefix: 24 }
    ]);
  });

  it('round-trips through parseConstraints, which refuses anything odd', () => {
    const { constraints } = buildConstraints({
      hostname: 'io',
      names: [],
      subnets: ['192.168.1.0/24']
    });
    expect(parseConstraints(JSON.parse(JSON.stringify(constraints)))).toEqual(constraints);
    expect(() => parseConstraints({ ...constraints, extra: 1 })).toThrow(ConstraintError);
    expect(() => parseConstraints({ ...constraints, dns: ['a b'] })).toThrow(ConstraintError);
    expect(() => parseConstraints({ ...constraints, subnets: ['10.0.0.0/8'] })).toThrow(
      ConstraintError
    );
  });
});

describe('coverage', () => {
  const input = { hostname: 'io', names: ['io.lan'], subnets: ['192.168.1.0/24'] };
  const { constraints } = buildConstraints(input, { excludeBelowSingleLabel: true });
  const { constraints: plain } = buildConstraints(input, { excludeBelowSingleLabel: false });
  it('without the switch, a single-label name also covers everything below it (the TLD risk)', () => {
    expect(coversName(plain, 'evil.io')).toBe(true);
    expect(coversName(plain, 'io')).toBe(true);
  });
  it('follows RFC 5280 suffix matching, minus the exclusions', () => {
    expect(coversName(constraints, 'io')).toBe(true);
    expect(coversName(constraints, 'IO.local')).toBe(true);
    expect(coversName(constraints, 'x.io.lan')).toBe(true);
    expect(coversName(constraints, 'evil.io')).toBe(false);
    expect(coversName(constraints, 'x.localhost')).toBe(false);
    expect(coversName(constraints, 'example.com')).toBe(false);
  });
  it('covers loopback and the accepted subnet only', () => {
    expect(coversAddress(constraints, '127.0.0.1')).toBe(true);
    expect(coversAddress(constraints, '::1')).toBe(true);
    expect(coversAddress(constraints, '192.168.1.200')).toBe(true);
    expect(coversAddress(constraints, '192.168.2.1')).toBe(false);
    expect(coversAddress(constraints, '127.0.0.2')).toBe(false);
    expect(coversAddress(constraints, 'nonsense')).toBe(false);
  });
});

describe('the default route', () => {
  it('finds the IPv4 default route, preferring the lowest metric', () => {
    expect(defaultRouteInterfaces(route4(LAN_ETH0, DEFAULT_WLAN0, DEFAULT_ETH0))).toEqual({
      v4: 'eth0'
    });
  });
  it('never picks an IPv4 reject route, even with a lower metric', () => {
    expect(defaultRouteInterfaces(route4(REJECT_DEFAULT, DEFAULT_ETH0))).toEqual({ v4: 'eth0' });
    expect(defaultRouteInterfaces(route4(REJECT_DEFAULT))).toEqual({});
  });
  it('finds the IPv6 default route and ignores lo and reject routes', () => {
    expect(
      defaultRouteInterfaces(
        route4(),
        [
          route6Default('lo', '00000001'),
          route6Default('wlan0', '00000100', '00200201'),
          route6Default('eth0')
        ].join('\n')
      )
    ).toEqual({ v6: 'eth0' });
  });
  it('has nothing without a default route (names-only leaf)', () => {
    expect(defaultRouteInterfaces(route4(LAN_ETH0), '')).toEqual({});
    expect(defaultRouteAddresses({}, PI)).toEqual([]);
    expect(candidateSubnet({}, PI)).toBeUndefined();
  });
  it('lists the default-route interface’s addresses only, without link-local', () => {
    expect(defaultRouteAddresses({ v4: 'eth0', v6: 'eth0' }, PI)).toEqual([
      '192.168.1.35',
      '2001:db8:1:2::35'
    ]);
    // Default route on wlan0, addresses on eth0 too: only wlan0 counts.
    expect(defaultRouteAddresses({ v4: 'wlan0' }, PI)).toEqual(['10.0.0.7']);
  });
  it('names no address from a bridge or VPN default route, in either family', () => {
    const vpn = {
      ...PI,
      wg0: [v4('10.8.0.2', '10.8.0.0/24'), v6('fd00:8::2', 'fd00:8::/64')]
    };
    expect(defaultRouteAddresses({ v4: 'wg0', v6: 'wg0' }, vpn)).toEqual([]);
    expect(defaultRouteAddresses({ v4: 'wg0', v6: 'eth0' }, vpn)).toEqual(['2001:db8:1:2::35']);
  });
  it('proposes the default-route interface’s IPv4 network, never a bridge or VPN', () => {
    expect(candidateSubnet({ v4: 'eth0' }, PI)).toEqual({ iface: 'eth0', cidr: '192.168.1.0/24' });
    expect(candidateSubnet({ v4: 'wg0' }, PI)).toBeUndefined();
    expect(candidateSubnet({ v4: 'docker0' }, PI)).toBeUndefined();
    // A DHCP change: the same interface, a new network.
    expect(
      candidateSubnet({ v4: 'eth0' }, { eth0: [v4('192.168.50.9', '192.168.50.9/24')] })
    ).toEqual({
      iface: 'eth0',
      cidr: '192.168.50.0/24'
    });
    // IPv6-only: no IPv4 candidate.
    expect(
      candidateSubnet({ v6: 'eth0' }, { eth0: [v6('2001:db8::5', '2001:db8::5/64')] })
    ).toBeUndefined();
  });
  it('warns when an explicitly named subnet belongs to a bridge or VPN', () => {
    expect(subnetWarning('10.8.0.0/24', PI)).toMatch(/wg0/);
    expect(subnetWarning('192.168.1.0/24', PI)).toBeUndefined();
  });
});

describe('leafNames', () => {
  const namesOnly = buildConstraints({ hostname: 'io', names: [], subnets: [] }).constraints;
  const lan = buildConstraints({
    hostname: 'io',
    names: ['io.lan'],
    subnets: ['192.168.1.0/24']
  }).constraints;

  it('names-only: host names and loopback, no LAN address, no warning about it', () => {
    expect(
      leafNames({ constraints: namesOnly, hostname: 'io', names: [], addresses: ['192.168.1.35'] })
    ).toEqual({
      dns: ['io', 'io.local', 'localhost'],
      ip: ['127.0.0.1', '::1'],
      outside: []
    });
  });

  it('with a subnet: the default-route address inside it; one outside it is reported', () => {
    expect(
      leafNames({
        constraints: lan,
        hostname: 'io',
        names: ['io.lan', '192.168.1.36'],
        addresses: ['192.168.1.35', '10.0.0.7']
      })
    ).toEqual({
      dns: ['io', 'io.local', 'localhost', 'io.lan'],
      ip: ['127.0.0.1', '::1', '192.168.1.36', '192.168.1.35'],
      outside: ['10.0.0.7']
    });
  });

  it('leaves out a renamed host that the CA does not cover, and says so', () => {
    expect(
      leafNames({ constraints: namesOnly, hostname: 'europa', names: [], addresses: [] })
    ).toEqual({
      dns: ['localhost'],
      ip: ['127.0.0.1', '::1'],
      outside: ['europa', 'europa.local']
    });
  });
});

describe('consequenceText', () => {
  it('states the scope and, per subnet, what a stolen key could do', () => {
    const { constraints } = buildConstraints({
      hostname: 'io',
      names: [],
      subnets: ['192.168.1.0/24']
    });
    const text = consequenceText(constraints).join('\n');
    expect(text).toContain(
      'Anyone holding its private key can impersonate hosts within those ranges.'
    );
    expect(text).toContain(
      'Accepting 192.168.1.0/24 allows this CA to issue certificates for any IP in that subnet.'
    );
    expect(text).toContain('io, io.local, localhost');
  });
});

describe('single-label names', () => {
  it('only the host and localhost may be single-label: "com" would cover all of *.com', () => {
    expect(() => buildConstraints({ hostname: 'io', names: ['com'], subnets: [] })).toThrow(
      /single-label name.*all of \*\.com/
    );
    expect(
      buildConstraints({ hostname: 'io', names: ['io', 'localhost'], subnets: [] }).constraints.dns
    ).toEqual(['io', 'io.local', 'localhost']);
    expect(
      buildConstraints({ hostname: 'io', names: ['pi.local'], subnets: [] }).constraints.dns
    ).toContain('pi.local');
  });
});

describe('constraints feed the issuer', () => {
  it('scopeOf hands issue.ts only masked network ranges it accepts', () => {
    const { constraints } = buildConstraints({
      hostname: 'io',
      names: [],
      subnets: ['192.168.1.0/24', 'fd00:1::/64']
    });
    expect(() => caExtensions(scopeOf(constraints))).not.toThrow();
  });
});

describe('address and subnet edge cases', () => {
  it('refuses IPv6 text with too few or too many groups', () => {
    for (const bad of ['1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8::', '1:2:3:4:5:6:7:8:9', '::1::', ':::']) {
      expect(() => parseAddress(bad)).toThrow(ConstraintError);
    }
    expect(formatAddress(parseAddress('1:2:3:4:5:6::8'))).toBe('1:2:3:4:5:6:0:8');
  });

  it('compresses only a run of two or more zero groups', () => {
    expect(formatAddress(parseAddress('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2:3:4:5:6');
    expect(formatAddress(parseAddress('1:0:1:1:1:1:1:1'))).toBe('1:0:1:1:1:1:1:1');
    expect(formatAddress(parseAddress('1:0:0:1:0:0:0:1'))).toBe('1:0:0:1::1');
  });

  it.each([
    '192.168.1.0',
    '192.168.1.0/24/1',
    '192.168.1.0/abc',
    '192.168.1.0/1234',
    '192.168.1.0/'
  ])('refuses %j as a subnet', (text) => {
    expect(() => parseCidr(text)).toThrow(/is not a subnet like 192\.168\.1\.0\/24/);
  });

  it('refuses a prefix longer than the address family allows', () => {
    expect(() => parseCidr('192.168.1.0/33')).toThrow(/prefix that is too long/);
    expect(() => parseCidr('2001:db8::/129')).toThrow(/prefix that is too long/);
    expect(parseCidr('192.168.1.7/32').text).toBe('192.168.1.7/32');
  });
});

describe('parseConstraints, what is refused', () => {
  const good = { dns: ['io', 'io.local'], excludedDns: ['.io'], subnets: ['192.168.1.0/24'] };

  it('needs an object', () => {
    for (const bad of [null, [], 'x', 3, undefined])
      expect(() => parseConstraints(bad)).toThrow('constraints must be an object');
  });

  it('needs three lists of strings', () => {
    for (const field of ['dns', 'excludedDns', 'subnets'] as const) {
      expect(() => parseConstraints({ ...good, [field]: 'x' })).toThrow(
        `constraints: ${field} must be a list of strings`
      );
      expect(() => parseConstraints({ ...good, [field]: [1] })).toThrow(
        `constraints: ${field} must be a list of strings`
      );
    }
    expect(() => parseConstraints({ dns: ['io'], excludedDns: [] })).toThrow(/subnets must be/);
  });

  it('refuses values that are not already in canonical form', () => {
    expect(() => parseConstraints({ ...good, dns: ['IO'] })).toThrow(/"IO" is not canonical/);
    expect(() => parseConstraints({ ...good, excludedDns: ['io'] })).toThrow(/bad exclusion "io"/);
    expect(() => parseConstraints({ ...good, excludedDns: ['.IO'] })).toThrow(
      /bad exclusion "\.IO"/
    );
    expect(() => parseConstraints({ ...good, subnets: ['2001:DB8:1::/48'] })).toThrow(
      /"2001:DB8:1::\/48" is not canonical/
    );
  });

  it('needs at least one DNS name, and accepts a valid record unchanged', () => {
    expect(() => parseConstraints({ ...good, dns: [] })).toThrow('constraints: no DNS names');
    expect(parseConstraints(good)).toEqual(good);
  });
});

describe('default route parsing, edge cases', () => {
  it('skips short or malformed lines and keeps the lowest metric whatever the order', () => {
    expect(defaultRouteInterfaces(route4('eth0\t00000000', DEFAULT_ETH0, DEFAULT_WLAN0))).toEqual({
      v4: 'eth0'
    });
    expect(
      defaultRouteInterfaces(
        route4(),
        ['too short', route6Default('eth0'), route6Default('wlan0', '00000900')].join('\n')
      )
    ).toEqual({ v6: 'eth0' });
  });

  it('ignores IPv6 routes that are not the default route', () => {
    const notDefaultPrefix = `${ZERO} 40 ${ZERO} 00 fe800000000000000000000000000001 00000400 00000001 00000000 00450003 eth0`;
    const notZeroDestination = `fd000000000000000000000000000000 00 ${ZERO} 00 ${ZERO} 00000400 00000001 00000000 00450003 eth0`;
    expect(
      defaultRouteInterfaces(route4(), [notDefaultPrefix, notZeroDestination].join('\n'))
    ).toEqual({});
  });

  it('names nothing for an interface that does not exist or has unusable entries', () => {
    expect(defaultRouteAddresses({ v4: 'nope', v6: 'nope' }, PI)).toEqual([]);
    const odd = {
      eth0: [
        v4('10.1.1.1', '10.1.1.1/24', true),
        v6('2001:db8::9', '2001:db8::9/64'),
        v4('192.168.1.35', '192.168.1.35/24')
      ],
      eth1: [
        v4('10.2.2.2', '10.2.2.2/24'),
        { ...v6('2001:db8::7', '2001:db8::7/64'), internal: true }
      ]
    };
    expect(defaultRouteAddresses({ v4: 'eth0' }, odd)).toEqual(['192.168.1.35']);
    expect(defaultRouteAddresses({ v6: 'eth1' }, odd)).toEqual([]);
  });

  it('proposes no subnet when the interface is missing, has no CIDR, or a range that is refused', () => {
    expect(candidateSubnet({ v4: 'nope' }, PI)).toBeUndefined();
    const { cidr: _unused, ...withoutCidr } = v4('192.168.1.35', '');
    expect(candidateSubnet({ v4: 'eth0' }, { eth0: [withoutCidr] })).toBeUndefined();
    expect(
      candidateSubnet({ v4: 'eth0' }, { eth0: [v4('169.254.3.4', '169.254.3.4/24')] })
    ).toBeUndefined();
    expect(
      candidateSubnet({ v4: 'eth0' }, { eth0: [v4('10.0.0.5', '10.0.0.5/8')] })
    ).toBeUndefined();
  });

  it('skips bridge entries it cannot read, and bridges with no entries', () => {
    const interfaces = {
      docker0: [v4('garbage', 'garbage/24'), v4('172.17.0.1', '172.17.0.1/16')],
      veth1: undefined
    };
    expect(subnetWarning('172.17.0.0/16', interfaces)).toMatch(/docker0/);
    expect(subnetWarning('192.168.9.0/24', interfaces)).toBeUndefined();
    expect(subnetWarning('172.17.0.0/16', { veth1: undefined })).toBeUndefined();
  });
});

describe('leafNames, edge cases', () => {
  const lan = buildConstraints({
    hostname: 'io',
    names: ['io.lan'],
    subnets: ['192.168.1.0/24']
  }).constraints;

  it('reports an address or name it cannot parse, and carries on', () => {
    expect(
      leafNames({ constraints: lan, hostname: 'io', names: ['a b'], addresses: ['garbage'] })
    ).toEqual({
      dns: ['io', 'io.local', 'localhost', 'io.lan'], // io.lan: the CA allows it, so the leaf carries it
      ip: ['127.0.0.1', '::1'],
      outside: ['a b', 'garbage']
    });
  });

  it('lists nothing twice', () => {
    expect(
      leafNames({
        constraints: lan,
        hostname: 'io',
        names: ['io', 'IO.LOCAL', '192.168.1.35'],
        addresses: ['192.168.1.35', '127.0.0.1', '10.0.0.7', '10.0.0.7']
      })
    ).toEqual({
      dns: ['io', 'io.local', 'localhost', 'io.lan'],
      ip: ['127.0.0.1', '::1', '192.168.1.35'],
      outside: ['10.0.0.7']
    });
    expect(
      leafNames({ constraints: lan, hostname: 'europa', names: ['europa'], addresses: [] }).outside
    ).toEqual(['europa', 'europa.local']);
  });
});

describe('consequenceText without exclusions', () => {
  it('leaves out the "except below" clause when nothing is excluded', () => {
    const { constraints } = buildConstraints(
      { hostname: 'io', names: [], subnets: [] },
      { excludeBelowSingleLabel: false }
    );
    const text = consequenceText(constraints).join('\n');
    expect(text).toContain('DNS: io, io.local, localhost (and names below them)');
    expect(text).not.toContain('except below');
    expect(text).not.toContain('Accepting');
  });
});
