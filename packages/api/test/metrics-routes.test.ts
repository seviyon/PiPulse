import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  insertSample,
  openDb,
  retentionSource,
  runHousekeeping,
  type PiPulseDb
} from '@pipulse/storage';
import { buildServer } from '../src/index.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const get = (url: string, options: Parameters<typeof buildServer>[1] = {}) =>
  buildServer(db, options).inject({ method: 'GET', url });

describe('GET /api/metrics/:id/history defaults', () => {
  it('without a window answers with the last hour, ending now', async () => {
    const now = Date.now();
    insertSample(db, { ts: now - 30 * MIN, metric: 'cpu_load', value: 1 });
    insertSample(db, { ts: now - 2 * HOUR, metric: 'cpu_load', value: 2 });
    const res = await get('/api/metrics/cpu_load/history');
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ value: number }>).map((row) => row.value)).toEqual([1]);
  });

  it('with only `to` it looks back an hour from there', async () => {
    insertSample(db, { ts: 9 * HOUR, metric: 'cpu_load', value: 1 });
    insertSample(db, { ts: 7 * HOUR, metric: 'cpu_load', value: 2 });
    const res = await get(`/api/metrics/cpu_load/history?to=${10 * HOUR}`);
    expect((res.json() as Array<{ value: number }>).map((row) => row.value)).toEqual([1]);
  });

  it('accepts a window of a single instant', async () => {
    insertSample(db, { ts: 1000, metric: 'cpu_load', value: 7 });
    const res = await get('/api/metrics/cpu_load/history?from=1000&to=1000');
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ value: number }>).map((row) => row.value)).toEqual([7]);
  });

  it('refuses a window that ends before it starts', async () => {
    const res = await get('/api/metrics/cpu_load/history?from=2000&to=1000');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'from must not be after to' });
  });
});

describe('GET /api/metrics/:id/series', () => {
  it('accepts a window of a single instant', async () => {
    insertSample(db, { ts: 1000, metric: 'cpu_load', value: 7 });
    const res = await get('/api/metrics/cpu_load/series?from=1000&to=1000&resolution=raw');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { points: Array<{ avg: number }> }).points.map((p) => p.avg)).toEqual([
      7
    ]);
  });

  it('refuses a window that ends before it starts', async () => {
    const res = await get('/api/metrics/cpu_load/series?from=2000&to=1000');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'from must not be after to' });
  });

  it('without a window answers with the last 24 hours', async () => {
    const now = Date.now();
    insertSample(db, { ts: now - 2 * HOUR, metric: 'cpu_load', value: 1 });
    insertSample(db, { ts: now - 30 * HOUR, metric: 'cpu_load', value: 2 });
    const res = await get('/api/metrics/cpu_load/series?resolution=raw');
    const { points } = res.json() as { points: Array<{ avg: number }> };
    expect(points.map((point) => point.avg)).toEqual([1]);
  });

  it('picks the resolution from the retention in force when the settings are wired in', async () => {
    const now = Date.now();
    for (let i = 0; i < 180; i++) {
      insertSample(db, { ts: now - i * MIN, metric: 'cpu_load', value: i });
    }
    runHousekeeping(db, now);
    const from = now - 3 * HOUR;
    // Without settings nothing says raw readings are pruned, so a small window stays raw.
    const plain = await get(`/api/metrics/cpu_load/series?from=${from}&to=${now}`);
    expect((plain.json() as { resolution: string }).resolution).toBe('raw');
    // With raw kept for one hour, three hours back has to come from the rollups.
    const settings = {
      getRetention: retentionSource(db, { PIPULSE_RETENTION_RAW: '1h' }, () => {}),
      metrics: [{ intervalMs: 5000 }],
      rawAtLeast: () => undefined
    };
    const limited = await get(`/api/metrics/cpu_load/series?from=${from}&to=${now}`, { settings });
    expect((limited.json() as { resolution: string }).resolution).not.toBe('raw');
  });
});
