import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { buildServer, createLiveFeed } from '../src/index.js';
import { hostOf, isAllowedHost, parseAllowedHosts } from '../src/host.js';

describe('hostOf', () => {
  it.each([
    ['io.lan', 'io.lan'],
    ['IO.LAN:8889', 'io.lan'],
    ['io.lan.', 'io.lan'],
    ['127.0.0.1:8889', '127.0.0.1'],
    ['[::1]:8889', '::1'],
    ['[2001:DB8::1]', '2001:db8::1'],
    ['localhost', 'localhost']
  ])('reads %s as %s', (header, expected) => {
    expect(hostOf(header)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    ' ',
    'a b',
    'io.lan:',
    'io.lan:80:80',
    '::1',
    '[::1',
    'io.lan/x',
    'a@b',
    '[io.lan]',
    '[10.0.0.1]:8889',
    '[]'
  ])('cannot read %j', (header) => {
    expect(hostOf(header)).toBeUndefined();
  });
});

describe('isAllowedHost', () => {
  const allowed = ['pi.example', 'io.lan'];

  it('accepts a listed name with or without a port, in any case', () => {
    expect(isAllowedHost('pi.example', allowed)).toBe(true);
    expect(isAllowedHost('PI.example:8889', allowed)).toBe(true);
    expect(isAllowedHost('io.lan.', allowed)).toBe(true);
  });

  it('accepts addresses and localhost whatever the list: a rebound name is never an address', () => {
    for (const host of [
      '127.0.0.1:8889',
      '192.168.1.35',
      '[::1]:8889',
      '[fe80::1]',
      'localhost:8889'
    ])
      expect(isAllowedHost(host, allowed)).toBe(true);
  });

  it('refuses any other name, a name below a listed one, and a header it cannot read', () => {
    for (const host of [
      'evil.example',
      'pi.example.evil.example',
      'x.pi.example',
      'pi.example@evil.example',
      'localhost.evil.example',
      undefined,
      ''
    ])
      expect(isAllowedHost(host, allowed)).toBe(false);
  });
});

describe('parseAllowedHosts', () => {
  it('is empty (no check) when unset or blank', () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts('  ')).toEqual([]);
  });

  it('lists lower-case names, trims, drops duplicates and trailing dots, and adds the extras', () => {
    expect(parseAllowedHosts(' Pi.Example , io.lan., pi.example', ['io', 'IO.local'])).toEqual([
      'pi.example',
      'io.lan',
      'io',
      'io.local'
    ]);
  });

  it.each(['*', '*.lan', 'a b', 'pi.example:8889', 'http://pi.example', ',,x_y'])(
    'refuses %j with one line naming the setting',
    (entry) => {
      expect(() => parseAllowedHosts(entry)).toThrow(/^PIPULSE_ALLOWED_HOSTS: /);
    }
  );
});

describe('the Host check on every request', () => {
  let db: PiPulseDb;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  const get = (
    allowedHosts: string[] | undefined,
    host: string | undefined,
    url = '/api/config'
  ) => {
    const app = buildServer(db, {
      ...(allowedHosts ? { allowedHosts } : {}),
      live: createLiveFeed()
    });
    return app
      .inject({ url, ...(host !== undefined ? { headers: { host } } : {}) })
      .finally(() => app.close());
  };

  it('does nothing when no list is set (the default): every Host is served', async () => {
    expect((await get(undefined, 'anything.example')).statusCode).toBe(200);
  });

  it('answers 421 to a name that is not listed, on the API, health and the dashboard alike', async () => {
    for (const url of ['/api/config', '/api/health', '/health', '/', '/api/live']) {
      const res = await get(['pi.example'], 'evil.example', url);
      expect(res.statusCode, url).toBe(421);
      expect(res.json()).toEqual({ error: 'host not allowed' });
    }
  });

  it('serves a listed name, an address and localhost', async () => {
    for (const host of ['pi.example:8889', '192.168.1.35:8889', '[::1]:8889', 'localhost']) {
      expect((await get(['pi.example'], host)).statusCode, host).toBe(200);
    }
  });

  /** The first line of the answer to hand-written request text over a real socket. */
  const raw = async (allowedHosts: string[], request: string) => {
    const app = buildServer(db, { allowedHosts, live: createLiveFeed() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const socket = connect((app.server.address() as AddressInfo).port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write(request);
      const [data] = (await once(socket, 'data')) as [Buffer];
      socket.destroy();
      return data.toString().split('\r\n')[0];
    } finally {
      await app.close();
    }
  };

  it('refuses a request with no Host header at all', async () => {
    expect(await raw(['pi.example'], 'GET /api/config HTTP/1.0\r\n\r\n')).toMatch(/ 421 /);
  });

  it('refuses a WebSocket upgrade for another name, and accepts one for a listed name', async () => {
    const upgrade = (host: string) =>
      `GET /api/live HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
    expect(await raw(['pi.example'], upgrade('evil.example'))).toMatch(/ 421 /);
    expect(await raw(['pi.example'], upgrade('pi.example'))).toMatch(/ 101 /);
  });
});
