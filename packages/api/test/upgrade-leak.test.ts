import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { buildServer, createLiveFeed, type ServerOptions } from '../src/index.js';
import { DEFAULT_LIMITS } from '../src/app.js';
import { hashPassword, parsePasswordHash } from '../src/auth.js';

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const UPGRADE_HEADERS = 'Connection: Upgrade\r\nUpgrade: websocket\r\n';
const WS_HEADERS = `${UPGRADE_HEADERS}Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n`;

/**
 * Sends `request` to a real server and says how it ended: the status line, and whether the server
 * closed the connection by itself within `waitMs` (the client never hangs up first).
 */
async function exchange(options: ServerOptions, request: string, waitMs = 1000) {
  const app = buildServer(db, { live: createLiveFeed(), ...options });
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const socket = connect((app.server.address() as AddressInfo).port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(request);
    const [data] = (await once(socket, 'data')) as [Buffer];
    const closed = await Promise.race([
      once(socket, 'close').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs))
    ]);
    socket.destroy();
    return { status: data.toString().split('\r\n')[0]!, closed };
  } finally {
    await app.close();
  }
}

describe('a refused request that carries an Upgrade header', () => {
  it('has its connection closed when no password is set (a write is a 403)', async () => {
    const result = await exchange(
      {},
      `POST /api/login HTTP/1.1\r\nHost: x\r\n${UPGRADE_HEADERS}Content-Length: 0\r\n\r\n`
    );
    expect(result.status).toMatch(/ 403 /);
    expect(result.closed).toBe(true);
  });

  it('has its connection closed when a write has no session (401)', async () => {
    const passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
    const result = await exchange(
      { auth: { passwordHash } },
      `POST /api/settings HTTP/1.1\r\nHost: x\r\n${UPGRADE_HEADERS}Content-Length: 0\r\n\r\n`
    );
    expect(result.status).toMatch(/ 401 /);
    expect(result.closed).toBe(true);
  });

  it('has its connection closed when a read needs a session (401 under read protection)', async () => {
    const passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
    const result = await exchange(
      { auth: { passwordHash, protectReads: true } },
      `GET /api/config HTTP/1.1\r\nHost: x\r\n${UPGRADE_HEADERS}\r\n`
    );
    expect(result.status).toMatch(/ 401 /);
    expect(result.closed).toBe(true);
  });

  it('has its connection closed when the Origin is refused', async () => {
    const passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
    const result = await exchange(
      { auth: { passwordHash } },
      `POST /api/login HTTP/1.1\r\nHost: x\r\nOrigin: http://evil.example\r\n${UPGRADE_HEADERS}Content-Length: 0\r\n\r\n`
    );
    expect(result.status).toMatch(/ 403 /);
    expect(result.closed).toBe(true);
  });

  it('still lets a real WebSocket upgrade through, and keeps it open', async () => {
    const result = await exchange(
      {},
      `GET /api/live HTTP/1.1\r\nHost: x\r\n${WS_HEADERS}\r\n`,
      400
    );
    expect(result.status).toMatch(/ 101 /);
    expect(result.closed).toBe(false);
  });
});

describe('a normal request without an Upgrade header', () => {
  it('keeps its connection open (keep-alive is unchanged)', async () => {
    const result = await exchange({}, 'GET /health HTTP/1.1\r\nHost: x\r\n\r\n', 400);
    expect(result.status).toMatch(/ 200 /);
    expect(result.closed).toBe(false);
  });
});

describe('limits on what one client can hold open', () => {
  it('drops a request whose body never finishes', async () => {
    // With a password set, sign-in is open to everybody, so its body is waited for.
    const passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
    const app = buildServer(db, { auth: { passwordHash }, limits: { requestTimeoutMs: 300 } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const socket = connect((app.server.address() as AddressInfo).port, '127.0.0.1');
      await once(socket, 'connect');
      socket.resume(); // read the 408, so the close is seen
      // Good headers, a body that is promised and never sent.
      socket.write(
        'POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'
      );
      const closed = await Promise.race([
        once(socket, 'close').then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
      ]);
      socket.destroy();
      expect(closed).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('refuses connections beyond the limit, and accepts again when one closes', async () => {
    const app = buildServer(db, { limits: { maxConnections: 2 } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (app.server.address() as AddressInfo).port;
      const open = async () => {
        const socket = connect(port, '127.0.0.1');
        await once(socket, 'connect');
        return socket;
      };
      const first = await open();
      const second = await open();
      // The server accepts the TCP connection and closes it at once, without a response.
      const third = await open();
      expect(await Promise.race([once(third, 'close').then(() => true), delay(1000)])).toBe(true);
      first.destroy();
      await once(first, 'close');
      await vi.waitFor(async () => {
        const again = await open();
        again.write('GET /health HTTP/1.1\r\nHost: x\r\n\r\n');
        const [data] = (await once(again, 'data')) as [Buffer];
        again.destroy();
        expect(data.toString()).toMatch(/ 200 /);
      });
      second.destroy();
    } finally {
      await app.close();
    }
  });

  it('drops a plain connection that sits idle past the connection timeout', async () => {
    const app = buildServer(db, { limits: { connectionTimeoutMs: 200 } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const socket = connect((app.server.address() as AddressInfo).port, '127.0.0.1');
      await once(socket, 'connect');
      socket.resume();
      expect(await Promise.race([once(socket, 'close').then(() => true), delay(3000)])).toBe(true);
      socket.destroy();
    } finally {
      await app.close();
    }
  });

  it('keeps an idle WebSocket open past the connection timeout', async () => {
    const app = buildServer(db, { live: createLiveFeed(), limits: { connectionTimeoutMs: 200 } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const socket = connect((app.server.address() as AddressInfo).port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write(`GET /api/live HTTP/1.1\r\nHost: x\r\n${WS_HEADERS}\r\n`);
      await once(socket, 'data');
      expect(await Promise.race([once(socket, 'close').then(() => true), delay(800)])).toBe(false);
      socket.destroy();
    } finally {
      await app.close();
    }
  });

  it('has defaults a dashboard fits in', () => {
    expect(DEFAULT_LIMITS).toEqual({
      requestTimeoutMs: 30_000,
      connectionTimeoutMs: 60_000,
      maxConnections: 256
    });
  });
});

const delay = (ms: number) =>
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms));
