import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { openDb, insertSample, type PiPulseDb } from '@pipulse/storage';
import { buildServer } from '../src/index.js';

describe('api routes', () => {
  let db: PiPulseDb;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('GET /health reports ok', async () => {
    const app = buildServer(db);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/metrics/latest returns the latest sample per metric', async () => {
    insertSample(db, { ts: 1000, metric: 'cpu_load', value: 10 });
    insertSample(db, { ts: 2000, metric: 'cpu_load', value: 20 });

    const app = buildServer(db);
    const res = await app.inject({ method: 'GET', url: '/api/metrics/latest' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ metric: string; value: number }>;
    expect(body).toEqual([{ ts: 2000, metric: 'cpu_load', value: 20 }]);
  });

  it('GET /api/metrics/:id/history returns samples within range', async () => {
    insertSample(db, { ts: 1000, metric: 'cpu_load', value: 10 });
    insertSample(db, { ts: 5000, metric: 'cpu_load', value: 30 });
    insertSample(db, { ts: 9000, metric: 'cpu_load', value: 50 });

    const app = buildServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/metrics/cpu_load/history?from=0&to=6000'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { ts: 1000, metric: 'cpu_load', value: 10 },
      { ts: 5000, metric: 'cpu_load', value: 30 }
    ]);
  });

  it('GET /api/metrics/:id/history rejects a non-numeric range', async () => {
    const app = buildServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/metrics/cpu_load/history?from=not-a-number'
    });
    expect(res.statusCode).toBe(400);
  });
});
