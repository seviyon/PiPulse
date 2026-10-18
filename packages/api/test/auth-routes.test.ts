import { connect, type AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { createSessions, hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer, createLiveFeed, type AuthOptions } from '../src/index.js';

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

let db: PiPulseDb;
let app: FastifyInstance | undefined;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  db.close();
});

function server(auth: AuthOptions, extra: { heartbeatMs?: number } = {}): FastifyInstance {
  app = buildServer(db, {
    auth: { failureDelayMs: 0, ...auth },
    live: createLiveFeed(),
    ...extra
  });
  return app;
}

async function signIn(api: FastifyInstance): Promise<string> {
  const res = await api.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'secret' }
  });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

type Mode = 'read-only' | 'signed out' | 'signed in';

async function status(
  mode: Mode,
  protectReads: boolean,
  method: 'GET' | 'POST' | 'PUT',
  url: string
): Promise<number> {
  const api = server(mode === 'read-only' ? { protectReads } : { passwordHash, protectReads });
  const cookie = mode === 'signed in' ? await signIn(api) : undefined;
  const res = await api.inject({
    method,
    url,
    ...(cookie ? { headers: { cookie } } : {}),
    ...(method === 'GET' ? {} : { payload: {} })
  });
  await api.close();
  app = undefined;
  return res.statusCode;
}

describe('enforcement', () => {
  it.each([
    // mode, protect reads, method, url, expected status
    ['read-only', false, 'GET', '/api/config', 200],
    ['read-only', true, 'GET', '/api/config', 401],
    ['read-only', false, 'PUT', '/api/settings', 403],
    ['signed out', false, 'GET', '/api/metrics/latest', 200],
    ['signed out', true, 'GET', '/api/metrics/latest', 401],
    ['signed out', true, 'GET', '/api/session', 200],
    ['signed out', false, 'PUT', '/api/settings', 401],
    ['signed out', true, 'PUT', '/api/settings', 401],
    ['signed in', true, 'GET', '/api/metrics/latest', 200],
    // Past the hook: no settings routes are registered in this test server.
    ['signed in', false, 'PUT', '/api/settings', 404],
    ['signed out', true, 'GET', '/health', 200],
    // Percent-encoded paths reach the same routes; the hook must see them too.
    ['signed out', true, 'GET', '/%61pi/metrics/latest', 401],
    ['signed out', true, 'GET', '/%61%70%69/config', 401],
    ['read-only', false, 'PUT', '/%61pi/settings', 403],
    ['signed out', false, 'PUT', '/%61pi/settings', 401]
  ] as const)(
    '%s, protect reads %s: %s %s → %i',
    async (mode, protectReads, method, url, expected) => {
      expect(await status(mode, protectReads, method, url)).toBe(expected);
    }
  );

  it('rejects a write from a foreign page even when signed in', async () => {
    const api = server({ passwordHash });
    const cookie = await signIn(api);
    const res = await api.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, origin: 'http://evil.example', host: 'io.lan:8889' }
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('absolute-form request targets', () => {
  // inject() normalises the target, so this needs a real socket.
  it('cannot slip a write past the hook', async () => {
    const api = server({});
    await api.listen({ port: 0, host: '127.0.0.1' });
    const port = (api.server.address() as AddressInfo).port;
    const body = '{"retention":{}}';
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          `PUT http://x/api/settings HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
        );
      });
      let data = '';
      socket.on('data', (chunk) => (data += String(chunk)));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
  });
});

describe('sign-in', () => {
  it('reports the session state', async () => {
    const api = server({ passwordHash, protectReads: true });
    expect((await api.inject({ url: '/api/session' })).json()).toEqual({
      editable: true,
      signedIn: false,
      protectReads: true
    });
    const cookie = await signIn(api);
    expect((await api.inject({ url: '/api/session', headers: { cookie } })).json()).toMatchObject({
      signedIn: true
    });
  });

  it('sets an HttpOnly, SameSite=Strict cookie, not Secure over plain HTTP', async () => {
    const res = await server({ passwordHash }).inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'secret' }
    });
    expect(res.headers['set-cookie']).toMatch(
      /^pipulse_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/
    );
  });

  it('answers a wrong password with the same body every time, then 429', async () => {
    const api = server({ passwordHash });
    for (let i = 0; i < 5; i++) {
      const res = await api.inject({
        method: 'POST',
        url: '/api/login',
        payload: { password: 'guess' }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'sign-in failed' });
    }
    const blocked = await api.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'secret' }
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('checks one password at a time per address, refusing the rest with 429', async () => {
    const api = server({ passwordHash });
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () =>
        api.inject({ method: 'POST', url: '/api/login', payload: { password: 'guess' } })
      )
    ).then((responses) => responses.map((res) => res.statusCode));
    expect(statuses.filter((code) => code === 401)).toHaveLength(1);
    expect(statuses.filter((code) => code === 429)).toHaveLength(9);
  });

  it('still counts sequential failures toward the limit', async () => {
    const api = server({ passwordHash });
    for (let i = 0; i < 5; i++) {
      await api.inject({ method: 'POST', url: '/api/login', payload: { password: 'guess' } });
    }
    const res = await api.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'secret' }
    });
    expect(res.statusCode).toBe(429);
  });

  it('signs out, and the old cookie stops working', async () => {
    const api = server({ passwordHash, protectReads: true });
    const cookie = await signIn(api);
    const out = await api.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(out.headers['set-cookie']).toMatch(/^pipulse_session=; .*Max-Age=0$/);
    expect((await api.inject({ url: '/api/config', headers: { cookie } })).statusCode).toBe(401);
  });

  it('refuses sign-in when no password is configured', async () => {
    const res = await server({}).inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'x' }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/editing is disabled/);
  });
});

describe('/api/live with read protection', () => {
  // A real socket, as in live.test.ts: injectWS never delivers the close event.
  it('closes a signed-out socket with 4401 and serves a signed-in one', async () => {
    const api = server({ passwordHash, protectReads: true });
    const cookie = await signIn(api);
    await api.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(api.server.address() as AddressInfo).port}/api/live`;

    const out = new WebSocket(url);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) =>
      out.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    );
    expect(closed).toEqual({ code: 4401, reason: 'sign in required' });

    const inside = new WebSocket(url, { headers: { cookie } });
    const first = await new Promise<string>((resolve) =>
      inside.once('message', (data) => resolve(String(data)))
    );
    expect(JSON.parse(first).type).toBe('snapshot');
    inside.terminate();
  });
});

describe('the session cookie follows the session', () => {
  const DAY = 86_400_000;
  it('is sent again once a day of use, so a daily user is not signed out on day seven', async () => {
    let now = 1_000_000;
    const api = server({ passwordHash, sessions: createSessions({ now: () => now }) });
    const cookie = await signIn(api);
    const id = cookie.split('=')[1];
    const get = () => api.inject({ url: '/api/session', headers: { cookie } });
    expect((await get()).headers['set-cookie']).toBeUndefined();
    now += DAY / 2;
    expect((await get()).headers['set-cookie']).toBeUndefined();
    now += DAY / 2;
    const again = await get();
    expect(again.headers['set-cookie']).toMatch(
      new RegExp(`^pipulse_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`)
    );
    expect((await get()).headers['set-cookie']).toBeUndefined();
  });

  it('is not sent to a request without a live session, nor with the sign-out answer', async () => {
    const api = server({ passwordHash });
    expect((await api.inject({ url: '/api/session' })).headers['set-cookie']).toBeUndefined();
    const cookie = await signIn(api);
    const out = await api.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect([out.headers['set-cookie']].flat()).toHaveLength(1);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });
});

describe('/api/live after sign-out', () => {
  it('closes a socket whose session ended, instead of streaming to it until it reconnects', async () => {
    const api = server({ passwordHash, protectReads: true }, { heartbeatMs: 30 });
    const cookie = await signIn(api);
    await api.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(api.server.address() as AddressInfo).port}/api/live`;
    const inside = new WebSocket(url, { headers: { cookie } });
    await new Promise<void>((resolve) => inside.once('message', () => resolve()));
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      inside.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    );
    await api.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(await closed).toEqual({ code: 4401, reason: 'sign in required' });
  });

  it('keeps a socket whose session is still live', async () => {
    const api = server({ passwordHash, protectReads: true }, { heartbeatMs: 30 });
    const cookie = await signIn(api);
    await api.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(api.server.address() as AddressInfo).port}/api/live`;
    const inside = new WebSocket(url, { headers: { cookie } });
    await new Promise<void>((resolve) => inside.once('message', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(inside.readyState).toBe(WebSocket.OPEN);
    inside.terminate();
  });
});
