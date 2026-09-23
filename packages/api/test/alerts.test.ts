import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { builtinRules, clearAlert, raiseAlert } from '@pipulse/alerts';
import { buildServer } from '../src/index.js';

const DAY = 86_400_000;
let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const alert = {
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  severity: 'critical' as const,
  message: 'CPU running hot',
  value: 82
};

describe('GET /api/alerts', () => {
  it('lists open alerts and the last 30 days of history, newest first', async () => {
    const now = Date.now();
    const old = raiseAlert(db, { ...alert, raisedAt: now - 40 * DAY });
    clearAlert(db, old.id, now - 39 * DAY, 'condition');
    const recent = raiseAlert(db, { ...alert, raisedAt: now - DAY });
    clearAlert(db, recent.id, now - DAY + 60_000, 'condition');
    const long = raiseAlert(db, { ...alert, raisedAt: now - 45 * DAY });
    clearAlert(db, long.id, now - 2 * DAY, 'condition');
    const open = raiseAlert(db, {
      ...alert,
      ruleId: 'disk_full',
      metric: 'disk_used',
      raisedAt: now - 50 * DAY
    });

    const res = await buildServer(db).inject({ method: 'GET', url: '/api/alerts' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((a: { id: number }) => a.id)).toEqual([recent.id, long.id, open.id]);

    const active = await buildServer(db).inject({ method: 'GET', url: '/api/alerts?state=active' });
    expect(active.json().map((a: { id: number }) => a.id)).toEqual([open.id]);

    const cleared = await buildServer(db).inject({
      method: 'GET',
      url: '/api/alerts?state=cleared'
    });
    expect(cleared.json().map((a: { id: number }) => a.id)).toEqual([recent.id, long.id]);
  });

  // Unknown fields aren't listed: Fastify's default validator strips them rather than rejecting.
  it.each(['state=open', 'limit=0', 'limit=1001', 'from=5&to=1'])(
    'rejects %s with 400',
    async (query) => {
      const res = await buildServer(db).inject({ method: 'GET', url: `/api/alerts?${query}` });
      expect(res.statusCode).toBe(400);
    }
  );
});

describe('GET /api/config', () => {
  it('includes the effective rules', async () => {
    const rules = builtinRules(4);
    const res = await buildServer(db, { rules }).inject({ method: 'GET', url: '/api/config' });
    expect(res.json().rules).toEqual(rules);
  });
});
