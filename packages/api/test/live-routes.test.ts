import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import type { Notice } from '../src/alert-routes.js';
import type { AlertEvent } from '@pipulse/alerts';
import { createFeed, createLiveFeed, buildServer, type Feed } from '../src/index.js';
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
  it('defaults to a 30 s heartbeat and 1 MiB of unsent backlog', () => {
    expect(liveLimits({})).toEqual({ heartbeatMs: 30_000, maxBufferedBytes: 1_048_576 });
  });

  it('takes what it is given, including a limit that is small', () => {
    expect(liveLimits({ heartbeatMs: 50, maxBufferedBytes: 64 })).toEqual({
      heartbeatMs: 50,
      maxBufferedBytes: 64
    });
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
