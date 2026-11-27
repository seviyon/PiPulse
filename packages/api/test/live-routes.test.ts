import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import type { Notice } from '../src/alert-routes.js';
import type { AlertEvent } from '@pipulse/alerts';
import { createFeed, createLiveFeed, buildServer, type Feed } from '../src/index.js';
import { DEFAULT_LIMITS } from '../src/app.js';
import { fallenBehind, liveLimits, registerLiveRoutes } from '../src/live-routes.js';

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('liveLimits', () => {
  it('defaults to a 30 s heartbeat, 1 MiB of unsent backlog and 64 sockets, 16 per address', () => {
    expect(liveLimits({})).toEqual({
      heartbeatMs: 30_000,
      maxBufferedBytes: 1_048_576,
      maxLiveClients: 64,
      maxLiveClientsPerAddress: 16
    });
  });

  it('leaves most of the server connections to other requests', () => {
    expect(liveLimits({}).maxLiveClients).toBeLessThanOrEqual(DEFAULT_LIMITS.maxConnections / 4);
  });

  it('takes what it is given, including a limit that is small', () => {
    const given = {
      heartbeatMs: 50,
      maxBufferedBytes: 64,
      maxLiveClients: 3,
      maxLiveClientsPerAddress: 2
    };
    expect(liveLimits(given)).toEqual(given);
  });
});

describe('fallenBehind', () => {
  it('is true only when more than the limit is queued unsent', () => {
    expect(fallenBehind(0, 64)).toBe(false);
    expect(fallenBehind(63, 64)).toBe(false);
    expect(fallenBehind(64, 64)).toBe(false);
    expect(fallenBehind(65, 64)).toBe(true);
  });
});

describe('/api/live refusing a cross-site page', () => {
  it('answers 403 with the reason, not an empty body', async () => {
    const app = buildServer(db, { live: createLiveFeed() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/live',
      headers: { origin: 'https://evil.example', host: 'io.lan:8889' }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'origin not allowed' });
    await app.close();
  });
});

describe('what a connection holds, and gives back when it closes', () => {
  /** A bare app with only the live routes, so the feeds can be watched from outside. */
  async function start() {
    const app = Fastify();
    let subscribers = 0;
    let alertSubscribers = 0;
    const notices = createFeed<Notice>();
    const counted: Feed<Notice> = {
      subscribe(listener) {
        subscribers++;
        const stop = notices.subscribe(listener);
        return () => {
          subscribers--;
          stop();
        };
      }
    };
    const alerts = createFeed<AlertEvent>();
    const countedAlerts: Feed<AlertEvent> = {
      subscribe(listener) {
        alertSubscribers++;
        const stop = alerts.subscribe(listener);
        return () => {
          alertSubscribers--;
          stop();
        };
      }
    };
    registerLiveRoutes(
      app,
      db,
      { live: createLiveFeed(), alertFeed: countedAlerts, heartbeatMs: 20 },
      {
        auth: { protectReads: false, signedIn: () => true } as never,
        notices: counted,
        allowedOrigins: []
      }
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    return { app, port, subscribers: () => subscribers, alertSubscribers: () => alertSubscribers };
  }

  it('stops listening for notices and alerts, and stops the heartbeat, once the client has gone', async () => {
    const { app, port, subscribers, alertSubscribers } = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    await new Promise<void>((resolve) => socket.once('message', () => resolve()));
    expect(subscribers()).toBe(1);
    expect(alertSubscribers()).toBe(1);
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    socket.close();
    await vi.waitFor(() => expect(subscribers()).toBe(0));
    expect(alertSubscribers()).toBe(0);
    expect(cleared).toHaveBeenCalled();
    await app.close();
  });
});

describe('how many /api/live sockets may be open', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const clients: WebSocket[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    for (const app of apps.splice(0)) await app.close();
  });

  /** Only the live routes; trustProxy lets a test say which address a connection comes from. */
  async function start(
    limits: { maxLiveClients: number; maxLiveClientsPerAddress: number },
    auth = { protectReads: false, signedIn: () => true }
  ) {
    const app = Fastify({ trustProxy: true });
    apps.push(app);
    registerLiveRoutes(
      app,
      db,
      { live: createLiveFeed(), ...limits },
      { auth: auth as never, notices: createFeed<Notice>(), allowedOrigins: [] }
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    return `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/live`;
  }

  /** Connects, and says whether the server sent its snapshot or dropped the socket. */
  function connect(url: string, from = '192.0.2.1') {
    const client = new WebSocket(url, { headers: { 'x-forwarded-for': from } });
    clients.push(client);
    const answer = new Promise<'served' | 'dropped' | number>((resolve) => {
      client.once('message', () => resolve('served'));
      client.once('close', (code) => resolve(code === 1006 ? 'dropped' : code));
      client.on('error', () => {});
    });
    return { client, answer };
  }

  it('drops the socket over the per-address limit, and serves another address', async () => {
    const url = await start({ maxLiveClients: 10, maxLiveClientsPerAddress: 2 });
    expect(await connect(url).answer).toBe('served');
    expect(await connect(url).answer).toBe('served');
    expect(await connect(url).answer).toBe('dropped');
    expect(await connect(url, '192.0.2.2').answer).toBe('served');
  });

  it('counts one IPv6 /64 as one address', async () => {
    const url = await start({ maxLiveClients: 10, maxLiveClientsPerAddress: 1 });
    expect(await connect(url, '2001:db8:1:2::1').answer).toBe('served');
    expect(await connect(url, '2001:db8:1:2:ffff::9').answer).toBe('dropped');
    expect(await connect(url, '2001:db8:1:3::1').answer).toBe('served');
  });

  it('drops the socket over the total limit, whatever the address', async () => {
    const url = await start({ maxLiveClients: 2, maxLiveClientsPerAddress: 2 });
    expect(await connect(url, '192.0.2.1').answer).toBe('served');
    expect(await connect(url, '192.0.2.2').answer).toBe('served');
    expect(await connect(url, '192.0.2.3').answer).toBe('dropped');
  });

  it('gives the place back when a socket closes, for its address and the total', async () => {
    const url = await start({ maxLiveClients: 1, maxLiveClientsPerAddress: 1 });
    const first = connect(url);
    expect(await first.answer).toBe('served');
    first.client.close();
    await expect.poll(() => connect(url).answer, { timeout: 2000 }).toBe('served');
  });

  it('counts a socket still closing for lack of a sign-in', async () => {
    const url = await start(
      { maxLiveClients: 1, maxLiveClientsPerAddress: 1 },
      { protectReads: true, signedIn: () => false }
    );
    // This client never reads, so it never answers the server's close and the socket stays held.
    const held = new WebSocket(url, { headers: { 'x-forwarded-for': '192.0.2.1' } });
    clients.push(held);
    held.on('error', () => {});
    await new Promise<void>((resolve) =>
      held.once('upgrade', (response) => {
        response.socket.pause();
        resolve();
      })
    );
    expect(await connect(url).answer).toBe('dropped');
  });
});
