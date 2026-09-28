import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { startNotifications, type Notifications } from '@pipulse/notify';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer } from '../src/index.js';

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

let db: PiPulseDb;
let app: FastifyInstance | undefined;
let notifications: Notifications | undefined;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(async () => {
  await app?.close();
  await notifications?.stop();
  app = undefined;
  notifications = undefined;
  db.close();
});

/** Real status from startNotifications, so the host is redacted by production code. */
function notifyFor(url: string): Notifications {
  notifications = startNotifications(db, {
    webhooks: [
      {
        id: 'apprise',
        url,
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        events: ['raised', 'cleared'],
        minSeverity: 'warning',
        timeoutMs: 1000
      }
    ],
    hostname: 'Io',
    metrics: [],
    intervalMs: 1e9,
    actions: [{ id: 'apprise', apiVersion: 1, deliver: async () => {} }]
  });
  return notifications;
}

describe('GET /api/notify', () => {
  it('answers an empty list without notifications', async () => {
    app = buildServer(db);
    const res = await app.inject({ method: 'GET', url: '/api/notify' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('serves webhook status with only the host of the URL, and no headers', async () => {
    const notify = notifyFor('https://user:pass@apprise.lan:8000/notify/key?x=1');
    app = buildServer(db, { notify });
    const res = await app.inject({ method: 'GET', url: '/api/notify' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(notify.status());
    expect(res.json()).toEqual([
      {
        id: 'apprise',
        host: 'apprise.lan:8000',
        method: 'POST',
        events: ['raised', 'cleared'],
        minSeverity: 'warning',
        pending: 0,
        lastSuccessAt: null,
        lastFailure: null
      }
    ]);
    expect(JSON.stringify(res.json())).not.toMatch(/user|pass|notify\/key|x=1|Bearer/);
  });

  it('needs a session when reads are protected', async () => {
    app = buildServer(db, {
      auth: { passwordHash, protectReads: true },
      notify: notifyFor('http://x')
    });
    const res = await app.inject({ method: 'GET', url: '/api/notify' });
    expect(res.statusCode).toBe(401);
  });
});
