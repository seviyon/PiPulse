import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  ConstraintError,
  SKIPPED_INTERFACE,
  buildConstraints,
  candidateSubnet,
  canonicalName,
  consequenceText,
  defaultRouteAddresses,
  defaultRouteInterfaces,
  leafNames,
  parseAddress,
  parseCidr,
  parseConstraints,
  type Constraints
} from '../src/ca/constraints.js';

const HEADER =
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
const ZERO = '0'.repeat(32);
const route4 = (...rows: string[]) => [HEADER, ...rows].join('\n');
const row4 = (iface: string, dest: string, flags: string, metric: string, mask: string) =>
  `${iface}\t${dest}\t0101A8C0\t${flags}\t0\t0\t${metric}\t${mask}\t0\t0\t0`;
const row6 = (iface: string, metric = '00000400', flags = '00450003', dest = ZERO) =>
  `${dest} 00 ${ZERO} 00 fe800000000000000000000000000001 ${metric} 00000001 00000000 ${flags} ${iface}`;

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

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
};

describe('error type and messages', () => {
  it('names the error class', () => {
    expect(new ConstraintError('x').name).toBe('ConstraintError');
  });

  it('quotes at most 64 characters of a refused name, with an ellipsis only when cut', () => {
    const sixtyFour = 'x'.repeat(64);
    const sixtyFive = 'x'.repeat(65);
    expect(messageOf(() => canonicalName(sixtyFour))).toBe(
      `"${sixtyFour}" is not a valid host name`
    );
    expect(messageOf(() => canonicalName(sixtyFive))).toBe(
      `"${sixtyFour}…" is not a valid host name`
    );
  });

  it('says a name with control characters or a bad shape is not a valid host name', () => {
    expect(messageOf(() => canonicalName('a\nb'))).toBe('"a\\nb" is not a valid host name');
    expect(messageOf(() => canonicalName('a_b'))).toBe('"a_b" is not a valid host name');
  });

  it('says what kind of address was refused', () => {
    expect(messageOf(() => parseAddress('1.2.3.256'))).toBe('"1.2.3.256" is not an IPv4 address');
    expect(messageOf(() => parseAddress('nonsense'))).toBe('"nonsense" is not an IP address');
  });

  it('names the unknown key in a constraints record', () => {
    expect(
      messageOf(() => parseConstraints({ dns: ['io'], excludedDns: [], subnets: [], extra: [] }))
    ).toBe('constraints: unknown key extra');
  });
});

describe('canonicalName keeps ASCII names as typed', () => {
  it('does not let the URL parser rewrite number-like labels into addresses', () => {
    // domainToASCII turns these into 127.0.0.1 and 1.2.0.3: the ASCII path must not use it.
    expect(canonicalName('0x7f.1')).toBe('0x7f.1');
    expect(canonicalName('1.2.3')).toBe('1.2.3');
    expect(canonicalName('xn--a')).toBe('xn--a');
    expect(canonicalName('ab')).toBe('ab');
  });
});

describe('address parsing', () => {
  it('trims around an address and refuses text after it', () => {
    expect(parseAddress(' 192.168.1.1 ').bytes).toEqual(Uint8Array.from([192, 168, 1, 1]));
    expect(parseAddress('\t::1\n').family).toBe(6);
    expect(() => parseAddress('1.2.3.4x')).toThrow('"1.2.3.4x" is not an IP address');
    expect(() => parseAddress('1.2.3.4.5')).toThrow('"1.2.3.4.5" is not an IP address');
  });
});

describe('subnet text', () => {
  it('trims around a subnet', () => {
    expect(parseCidr('  192.168.1.0/24  ').text).toBe('192.168.1.0/24');
  });

  it('shows the host-bits suggestion without the surrounding blanks', () => {
    expect(messageOf(() => parseCidr('  192.168.1.35/24  '))).toBe(
      '192.168.1.35/24 has host bits set; use 192.168.1.0/24'
    );
  });
});

describe('bridge and VPN interface names', () => {
  it('matches only names that start with the prefix', () => {
    for (const name of ['docker0', 'br-1a2b', 'veth9f', 'tun0', 'wg0']) {
      expect(SKIPPED_INTERFACE.test(name)).toBe(true);
    }
    for (const name of ['eth0', 'mydocker0', 'xwg0', 'eth-br-1', 'wlan-tun0', 'enp3s0']) {
      expect(SKIPPED_INTERFACE.test(name)).toBe(false);
    }
    // so a real interface that merely contains the prefix is still proposed
    expect(
      candidateSubnet({ v4: 'ethwg0' }, { ethwg0: [v4('192.168.1.5', '192.168.1.5/24')] })
    ).toEqual({
      iface: 'ethwg0',
      cidr: '192.168.1.0/24'
    });
    expect(
      defaultRouteAddresses({ v4: 'mydocker0' }, { mydocker0: [v4('192.168.7.5', '')] })
    ).toEqual(['192.168.7.5']);
  });
});

describe('PIPULSE_TLS_NAMES addresses', () => {
  it('warns about an address even with blanks around it, quoting it trimmed', () => {
    const { constraints, warnings } = buildConstraints({
      hostname: 'io',
      names: ['  192.168.1.35  '],
      subnets: []
    });
    expect(constraints.dns).toEqual(['io', 'io.local', 'localhost']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^PIPULSE_TLS_NAMES: 192\.168\.1\.35 is an address, not a name/);
  });
});

describe('the IPv4 default route', () => {
  it('reads fields split by any run of whitespace, with blanks around the line', () => {
    const spaced = '  eth0   00000000   0101A8C0   0003  0  0  202   00000000  0 0 0   ';
    expect(defaultRouteInterfaces(route4(spaced))).toStrictEqual({ v4: 'eth0' });
  });

  it('accepts a row with exactly eight fields', () => {
    expect(
      defaultRouteInterfaces(route4('eth0 00000000 0101A8C0 0003 0 0 202 00000000'))
    ).toStrictEqual({
      v4: 'eth0'
    });
  });

  it('needs the destination and the mask both to be zero', () => {
    expect(
      defaultRouteInterfaces(route4(row4('eth5', '00000000', '0003', '5', '00FFFFFF')))
    ).toStrictEqual({});
    expect(
      defaultRouteInterfaces(route4(row4('eth6', '0001A8C0', '0003', '5', '00000000')))
    ).toStrictEqual({});
  });

  it('needs the route to be up', () => {
    expect(
      defaultRouteInterfaces(route4(row4('eth7', '00000000', '0002', '5', '00000000')))
    ).toStrictEqual({});
  });

  it('keeps the first of two routes with the same metric', () => {
    expect(
      defaultRouteInterfaces(
        route4(
          row4('eth0', '00000000', '0003', '100', '00000000'),
          row4('wlan0', '00000000', '0003', '100', '00000000')
        )
      )
    ).toStrictEqual({ v4: 'eth0' });
  });
});

describe('the IPv6 default route', () => {
  it('reads fields split by any run of whitespace, with blanks around the line', () => {
    const spaced = `  ${ZERO}  00  ${ZERO}  00  fe800000000000000000000000000001  00000400   00000001 00000000  00450003   eth0  `;
    expect(defaultRouteInterfaces(route4(), spaced)).toStrictEqual({ v6: 'eth0' });
  });

  it('needs ten fields: a row cut before the interface name names nothing', () => {
    const nineFields = `${ZERO} 00 ${ZERO} 00 fe800000000000000000000000000001 00000400 00000001 00000000 00450003`;
    expect(defaultRouteInterfaces(route4(), nineFields)).toStrictEqual({});
  });

  it('needs a destination of exactly 32 zeros', () => {
    expect(
      defaultRouteInterfaces(route4(), row6('eth0', '00000400', '00450003', `1${ZERO}`))
    ).toStrictEqual({});
    expect(
      defaultRouteInterfaces(route4(), row6('eth0', '00000400', '00450003', `${ZERO}1`))
    ).toStrictEqual({});
  });

  it('needs the route to be up', () => {
    expect(defaultRouteInterfaces(route4(), row6('eth0', '00000400', '00450002'))).toStrictEqual(
      {}
    );
  });

  it('lets a later route with a lower metric win, and keeps the first on a tie', () => {
    expect(
      defaultRouteInterfaces(
        route4(),
        [row6('wlan0', '00000900'), row6('eth0', '00000400')].join('\n')
      )
    ).toStrictEqual({ v6: 'eth0' });
    expect(
      defaultRouteInterfaces(
        route4(),
        [row6('eth0', '00000400'), row6('wlan0', '00000400')].join('\n')
      )
    ).toStrictEqual({ v6: 'eth0' });
  });
});

describe('the interface address candidate', () => {
  it('skips an interface entry that is IPv6 or internal and takes the first real IPv4 one', () => {
    const eth0 = [
      v6('2001:db8::5', '2001:db8::5/64'),
      v4('10.1.1.1', '10.1.1.1/24', true),
      v4('192.168.1.35', '192.168.1.35/24')
    ];
    expect(candidateSubnet({ v4: 'eth0' }, { eth0 })).toEqual({
      iface: 'eth0',
      cidr: '192.168.1.0/24'
    });
  });
});

describe('leaf names from the CA', () => {
  const make = (dns: string[]): Constraints => ({ dns, excludedDns: [], subnets: [] });

  it('carries an alias ending in .local when its short form is not a CA name', () => {
    const result = leafNames({
      constraints: make(['io', 'io.local', 'localhost', 'pi.local']),
      hostname: 'io',
      names: [],
      addresses: []
    });
    expect(result.dns).toEqual(['io', 'io.local', 'localhost', 'pi.local']);
  });

  it('carries a dotted alias even when cutting six characters off it gives another CA name', () => {
    // 'a.bcdef' minus its last six characters is 'a', which the CA also allows.
    const result = leafNames({
      constraints: make(['a', 'a.local', 'localhost', 'a.bcdef']),
      hostname: 'a',
      names: [],
      addresses: []
    });
    expect(result.dns).toEqual(['a', 'a.local', 'localhost', 'a.bcdef']);
  });
});

describe('leaf names typed by the operator', () => {
  const lan = buildConstraints({
    hostname: 'io',
    names: [],
    subnets: ['192.168.1.0/24']
  }).constraints;

  it('takes an address with blanks around it as an address', () => {
    const result = leafNames({
      constraints: lan,
      hostname: 'io',
      names: [' 192.168.1.36 '],
      addresses: []
    });
    expect(result.ip).toEqual(['127.0.0.1', '::1', '192.168.1.36']);
    expect(result.outside).toEqual([]);
  });

  it('reports an address outside the accepted subnets, even one given as a name', () => {
    const result = leafNames({
      constraints: lan,
      hostname: 'io',
      names: ['10.0.0.9'],
      addresses: []
    });
    expect(result.ip).toEqual(['127.0.0.1', '::1']);
    expect(result.outside).toEqual(['10.0.0.9']);
  });

  it('reports an unusable address trimmed', () => {
    const result = leafNames({
      constraints: lan,
      hostname: 'io',
      names: [' fe80::1%eth0 '],
      addresses: []
    });
    expect(result.outside).toEqual(['fe80::1%eth0']);
  });

  it('reports an invalid name trimmed', () => {
    const result = leafNames({
      constraints: lan,
      hostname: 'io',
      names: ['  a b  '],
      addresses: []
    });
    expect(result.outside).toEqual(['a b']);
  });
});

describe('consequenceText wording', () => {
  it('lists the exclusions without their dots and the IP ranges comma-separated', () => {
    const { constraints } = buildConstraints({
      hostname: 'io',
      names: [],
      subnets: ['192.168.1.0/24', '10.20.0.0/16']
    });
    expect(consequenceText(constraints)).toEqual([
      'This CA will be trusted for the following DNS names and IP ranges. Anyone holding its private key can impersonate hosts within those ranges.',
      '  DNS: io, io.local, localhost (and names below them, except below io, localhost)',
      '  IP:  127.0.0.1/32, ::1/128, 192.168.1.0/24, 10.20.0.0/16',
      'Accepting 192.168.1.0/24 allows this CA to issue certificates for any IP in that subnet. A stolen CA key could impersonate other devices there.',
      'Accepting 10.20.0.0/16 allows this CA to issue certificates for any IP in that subnet. A stolen CA key could impersonate other devices there.'
    ]);
  });
});
