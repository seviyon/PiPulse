import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { openDb, insertSample, type PiPulseDb, type Sample } from '@pipulse/storage';
import { buildServer, createLiveFeed } from '../src/index.js';

let db: PiPulseDb;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

/**
 * Starts `app` on an ephemeral local port and opens a real WebSocket to
 * /api/live, buffering every JSON message from the moment it connects
 * (the server sends its snapshot immediately). A real socket rather than
 * injectWS(): injectWS's in-memory stream never delivers the server-side
 * 'close' event, which is exactly what the disconnect test needs.
 */
async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

async function connect(
  app: FastifyInstance,
  clientOptions: ConstructorParameters<typeof WebSocket>[2] = {}
) {
  const port = await listen(app);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, clientOptions);
  const messages: unknown[] = [];
  const waiters: ((message: unknown) => void)[] = [];
  socket.on('message', (data) => {
    const message: unknown = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  await once(socket, 'open');
  const next = () =>
    messages.length > 0
      ? Promise.resolve(messages.shift())
      : new Promise<unknown>((resolve) => waiters.push(resolve));
  return { socket, next };
}

describe('createLiveFeed', () => {
  it('delivers published samples to every subscriber until they unsubscribe', () => {
    const feed = createLiveFeed();
    const a: Sample[] = [];
    const b: Sample[] = [];
    const unsubscribeA = feed.subscribe((sample) => a.push(sample));
    feed.subscribe((sample) => b.push(sample));

    feed.publish({ ts: 1, metric: 'cpu_load', value: 5 });
    unsubscribeA();
    feed.publish({ ts: 2, metric: 'cpu_load', value: 6 });

    expect(a.map((s) => s.ts)).toEqual([1]);
    expect(b.map((s) => s.ts)).toEqual([1, 2]);
  });

  it('keeps delivering to other subscribers when one throws', () => {
    const feed = createLiveFeed();
    const received: Sample[] = [];
    feed.subscribe(() => {
      throw new Error('closed socket');
    });
    feed.subscribe((sample) => received.push(sample));

    expect(() => feed.publish({ ts: 1, metric: 'm', value: 1 })).not.toThrow();
    expect(received).toHaveLength(1);
  });
});

describe('GET /api/config', () => {
  it('returns device info and the registered plugins', async () => {
    const app = buildServer(db, {
      device: { hostname: 'pihole', platform: 'linux', arch: 'arm' },
      plugins: [{ id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 }]
    });

    const res = await app.inject({ method: 'GET', url: '/api/config' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      device: { hostname: 'pihole', platform: 'linux', arch: 'arm' },
      plugins: [{ id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 }],
      serverTime: expect.any(Number)
    });
  });
});

describe('GET /api/metrics/:id/history validation', () => {
  it.each([
    ['a negative timestamp', 'from=-5'],
    ['a fractional timestamp', 'to=1.5'],
    ['an empty value', 'from='],
    ['from after to', 'from=6000&to=1000']
  ])('rejects %s with 400', async (_case, query) => {
    const app = buildServer(db);
    const res = await app.inject({ method: 'GET', url: `/api/metrics/cpu_load/history?${query}` });
    expect(res.statusCode).toBe(400);
  });

  it('returns an empty list for a metric with no samples', async () => {
    const app = buildServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/metrics/unknown_metric/history?from=0&to=1000'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('WebSocket /api/live', () => {
  it('sends a snapshot of the latest values on connect, then each new sample', async () => {
    insertSample(db, { ts: 1000, metric: 'cpu_load', value: 10 });
    const live = createLiveFeed();
    const app = buildServer(db, { live });

    const { socket, next } = await connect(app);
    const snapshot = await next();
    const pushed = next();
    live.publish({ ts: 2000, metric: 'cpu_load', value: 20 });

    expect(snapshot).toEqual({
      type: 'snapshot',
      samples: [{ ts: 1000, metric: 'cpu_load', value: 10 }]
    });
    expect(await pushed).toEqual({ type: 'sample', ts: 2000, metric: 'cpu_load', value: 20 });

    socket.terminate();
    await app.close();
  });

  it('stops pushing to a client once it disconnects', async () => {
    const live = createLiveFeed();
    let subscribers = 0;
    const counting = {
      publish: live.publish,
      subscribe: (listener: (sample: Sample) => void) => {
        subscribers++;
        const unsubscribe = live.subscribe(listener);
        return () => {
          subscribers--;
          unsubscribe();
        };
      }
    };
    const app = buildServer(db, { live: counting });

    const { socket, next } = await connect(app);
    await next();
    expect(subscribers).toBe(1);

    socket.close();
    await once(socket, 'close');
    await expect.poll(() => subscribers).toBe(0);

    await app.close();
  });
});

/** Resolves with the HTTP status the server answered a WebSocket upgrade with. */
async function upgradeStatus(
  app: FastifyInstance,
  origin: string | ((port: number) => string)
): Promise<number> {
  const port = await listen(app);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, {
    origin: typeof origin === 'function' ? origin(port) : origin
  });
  return new Promise((resolve) => {
    socket.on('open', () => {
      socket.terminate();
      resolve(101);
    });
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
  });
}

/**
 * Opens /api/live with a raw TCP upgrade, waits for the 101, then pauses the
 * socket: a client that has stopped reading entirely (never sees pings,
 * samples or close frames), like a laptop that went to sleep.
 */
async function stalledClient(port: number): Promise<net.Socket> {
  const raw = net.connect(port, '127.0.0.1');
  await once(raw, 'connect');
  raw.write(
    'GET /api/live HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
  );
  await once(raw, 'data');
  raw.pause();
  return raw;
}

/** Wraps a feed to count live subscriptions (one per connected /api/live client). */
function countingFeed() {
  const live = createLiveFeed();
  const counter = { subscribers: 0 };
  const feed = {
    publish: live.publish,
    subscribe: (listener: (sample: Sample) => void) => {
      counter.subscribers++;
      const unsubscribe = live.subscribe(listener);
      return () => {
        counter.subscribers--;
        unsubscribe();
      };
    }
  };
  return { feed, counter };
}

describe('WebSocket /api/live origin check', () => {
  it('rejects a cross-site browser origin with 403', async () => {
    const app = buildServer(db, { live: createLiveFeed() });
    expect(await upgradeStatus(app, 'https://evil.example')).toBe(403);
    await app.close();
  });

  it('rejects the opaque "null" origin', async () => {
    const app = buildServer(db, { live: createLiveFeed() });
    expect(await upgradeStatus(app, 'null')).toBe(403);
    await app.close();
  });

  it('accepts a page served from the same host', async () => {
    const app = buildServer(db, { live: createLiveFeed() });
    expect(await upgradeStatus(app, (port) => `http://127.0.0.1:${port}`)).toBe(101);
    await app.close();
  });

  it('accepts an explicitly allowed origin', async () => {
    const app = buildServer(db, {
      live: createLiveFeed(),
      allowedOrigins: ['https://pipulse.lan']
    });
    expect(await upgradeStatus(app, 'https://pipulse.lan')).toBe(101);
    await app.close();
  });
});

describe('WebSocket /api/live dead-client handling', () => {
  it('terminates a client that stops answering pings', async () => {
    const live = createLiveFeed();
    const app = buildServer(db, { live, heartbeatMs: 50 });

    const { socket, next } = await connect(app, { autoPong: false });
    await next();
    const [code] = (await once(socket, 'close')) as [number];

    expect(code).toBe(1006); // abnormal closure: the server dropped the TCP connection
    await app.close();
  });

  it('keeps a client that answers pings', async () => {
    const live = createLiveFeed();
    const app = buildServer(db, { live, heartbeatMs: 50 });

    const { socket, next } = await connect(app);
    await next();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.terminate();
    await app.close();
  });

  it('terminates a client whose unsent backlog exceeds maxBufferedBytes', async () => {
    const { feed, counter } = countingFeed();
    const app = buildServer(db, { live: feed, maxBufferedBytes: 64 * 1024 });
    const raw = await stalledClient(await listen(app));
    expect(counter.subscribers).toBe(1);

    // Far more than the kernel socket buffers hold, so ws has to queue in memory.
    for (let ts = 0; ts < 200_000; ts++) {
      feed.publish({ ts, metric: 'cpu_load', value: ts });
    }

    await expect.poll(() => counter.subscribers).toBe(0);
    raw.destroy();
    await app.close();
  });

  it('closes promptly even when a client never answers the close handshake', async () => {
    const app = buildServer(db, { live: createLiveFeed() });
    const raw = await stalledClient(await listen(app));

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2000);
    raw.destroy();
  });
});
