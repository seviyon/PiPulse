import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  insertSample,
  openDb,
  retentionSource,
  type PiPulseDb,
  type RetentionSettings
} from '@pipulse/storage';
import { builtinRules } from '@pipulse/alerts';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer } from '../src/index.js';
import { longestLookBack } from '../src/settings-routes.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 20);

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

let db: PiPulseDb;
let app: FastifyInstance;
let cookie: string;
let getRetention: () => RetentionSettings;

async function start(env: Record<string, string> = {}) {
  getRetention = retentionSource(db, env, () => {});
  app = buildServer(db, {
    auth: { passwordHash, failureDelayMs: 0 },
    settings: {
      getRetention,
      rawAtLeast: longestLookBack(builtinRules(4)),
      metrics: [{ intervalMs: 5000 }],
      diskFree: () => 10 ** 10,
      now: () => NOW
    }
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'secret' }
  });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
}

const put = (payload: object) =>
  app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload });

beforeEach(() => {
  db = openDb(':memory:');
  for (let ts = NOW - 3 * DAY; ts <= NOW; ts += HOUR) {
    insertSample(db, { ts, metric: 'cpu_load', value: 1 });
  }
});
afterEach(async () => {
  // Not every test starts a server (longestLookBack is pure).
  await (app as FastifyInstance | undefined)?.close();
  app = undefined as unknown as FastifyInstance;
  db.close();
});

describe('longestLookBack', () => {
  it('finds the rule that looks back furthest', () => {
    expect(longestLookBack(builtinRules(4))).toEqual({
      ms: 15 * 60_000,
      ruleId: 'load_queueing',
      text: '15min'
    });
    expect(longestLookBack([])).toBeUndefined();
  });
});

describe('GET /api/settings', () => {
  it('shows each level with its source and lock, and storage figures', async () => {
    await start({ PIPULSE_RETENTION_1D: 'forever' });
    const body = (await app.inject({ url: '/api/settings' })).json();
    expect(body.retention.raw).toEqual({
      text: '2d',
      ms: 2 * DAY,
      source: 'default',
      variable: 'PIPULSE_RETENTION_RAW',
      locked: false
    });
    expect(body.retention['1d']).toMatchObject({ ms: null, source: 'env', locked: true });
    expect(body.storage).toMatchObject({ diskFreeBytes: 10 ** 10, levels: { raw: { rows: 73 } } });
  });
});

describe('POST /api/settings/preview', () => {
  it('previews what a shorter policy deletes and the estimated size', async () => {
    await start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/preview',
      headers: { cookie },
      payload: { retention: { raw: '1d' } }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deletions.raw).toEqual({
      deletesRows: 48,
      from: NOW - 3 * DAY,
      to: NOW - DAY
    });
    expect(res.json().estimatedBytes).toBeGreaterThan(0);
  });

  it('reports invalid fields with 400', async () => {
    await start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/preview',
      headers: { cookie },
      payload: { retention: { raw: '10min' } }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.raw).toMatch(/rule "load_queueing" looks back 15min/);
  });

  it('needs a session like any write', async () => {
    await start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/preview',
      payload: { retention: {} }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /api/settings', () => {
  it('refuses a deleting change without confirmation, then saves it with', async () => {
    await start();
    const refused = await put({ retention: { raw: '1d' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().deletions.raw.deletesRows).toBe(48);
    expect(getRetention().raw.source).toBe('default');

    const saved = await put({ retention: { raw: '1d' }, confirmDeletion: true });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().retention.raw).toMatchObject({ text: '1d', source: 'saved' });
    expect(getRetention().raw.ms).toBe(DAY);
  });

  it('saves a longer retention without confirmation', async () => {
    await start();
    expect((await put({ retention: { raw: '7d' } })).statusCode).toBe(200);
  });

  it('refuses to change a level locked by the environment', async () => {
    await start({ PIPULSE_RETENTION_RAW: '2d' });
    const res = await put({ retention: { raw: '7d' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.raw).toMatch(/set by PIPULSE_RETENTION_RAW/);
  });

  it('rejects a value that is not a duration', async () => {
    await start();
    // Fastify coerces 7 to "7" (and strips unknown fields); the duration check still refuses it.
    const res = await put({ retention: { raw: 7 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.raw).toMatch(/must be a duration/);
  });
});
