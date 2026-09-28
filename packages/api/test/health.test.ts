import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { createHealth, READING_STALE_MS } from '../src/health.js';
import { buildServer } from '../src/index.js';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';

let db: PiPulseDb;
let mono: number;
beforeEach(() => {
  db = openDb(':memory:');
  mono = 0;
});
afterEach(() => db.close());

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

describe('createHealth', () => {
  it('is unhealthy until the first reading, then healthy while readings arrive', () => {
    const health = createHealth(db, { monotonic: () => mono, trackReadings: true });
    // A version that starts but can't collect must not look healthy (the installer rolls it back).
    expect(health.check()).toEqual({ ok: false, problems: ['no readings yet'] });
    mono += 5_000;
    health.markReading();
    expect(health.check()).toEqual({ ok: true, problems: [] });
    mono += READING_STALE_MS - 1;
    health.markReading();
    mono += READING_STALE_MS - 1;
    expect(health.check().ok).toBe(true);
  });

  it('reports no readings for 5 min, on the monotonic clock only', () => {
    const health = createHealth(db, { monotonic: () => mono, trackReadings: true });
    health.markReading();
    mono += READING_STALE_MS;
    expect(health.check()).toEqual({ ok: false, problems: ['no readings for 5 min'] });
  });

  it('ignores the wall clock (an NTP jump does not flip it)', () => {
    const realNow = Date.now;
    const health = createHealth(db, { monotonic: () => mono, trackReadings: true });
    health.markReading();
    Date.now = () => realNow() + 10 * 60 * 60_000;
    try {
      expect(health.check().ok).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('skips the reading check when not tracking readings', () => {
    const health = createHealth(db, { monotonic: () => mono });
    mono += READING_STALE_MS * 10;
    expect(health.check().ok).toBe(true);
  });

  it('reports the database once it is unusable', () => {
    const health = createHealth(db, { monotonic: () => mono });
    db.close();
    expect(health.check()).toEqual({ ok: false, problems: ['database unavailable'] });
    db = openDb(':memory:');
  });
});

describe('GET /api/health', () => {
  it('answers 200 when healthy and 503 naming the problem when not', async () => {
    const health = createHealth(db, { monotonic: () => mono, trackReadings: true });
    const app = buildServer(db, { health });
    expect((await app.inject('/api/health')).json()).toEqual({
      status: 'unhealthy',
      problems: ['no readings yet']
    });
    health.markReading();
    expect((await app.inject('/api/health')).json()).toEqual({ status: 'ok' });
    mono += READING_STALE_MS;
    const res = await app.inject('/api/health');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unhealthy', problems: ['no readings for 5 min'] });
    await app.close();
  });

  it('stays public when reads are protected', async () => {
    const app = buildServer(db, { auth: { passwordHash, protectReads: true } });
    expect((await app.inject('/api/config')).statusCode).toBe(401);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    await app.close();
  });
});
