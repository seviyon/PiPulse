import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertSample, openDb, runHousekeeping, type PiPulseDb } from '@pipulse/storage';
import { buildServer } from '../src/index.js';

const MIN = 60_000;
const DAY = 86_400_000;

let db: PiPulseDb;
let now: number;

beforeEach(() => {
  db = openDb(':memory:');
  now = Math.floor(Date.now() / MIN) * MIN;
  insertSample(db, { ts: now - 3 * MIN, metric: 'cpu_load', value: 2 });
  insertSample(db, { ts: now - 3 * MIN + 30_000, metric: 'cpu_load', value: 4 });
  insertSample(db, { ts: now - 2 * MIN, metric: 'cpu_load', value: 6 });
  runHousekeeping(db, now);
});

afterEach(() => {
  db.close();
});

async function series(query: string) {
  const app = buildServer(db);
  return app.inject({ method: 'GET', url: `/api/metrics/cpu_load/series?${query}` });
}

describe('GET /api/metrics/:id/series', () => {
  it('picks raw data for a short range', async () => {
    const res = await series(`from=${now - 10 * MIN}&to=${now}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      resolution: 'raw',
      points: [
        { ts: now - 3 * MIN, avg: 2, min: 2, max: 2, count: 1 },
        { ts: now - 3 * MIN + 30_000, avg: 4, min: 4, max: 4, count: 1 },
        { ts: now - 2 * MIN, avg: 6, min: 6, max: 6, count: 1 }
      ]
    });
  });

  it('serves every reading for a day-long range while they still fit (a young database)', async () => {
    const res = await series(`from=${now - DAY}&to=${now}`);
    expect(res.json()).toMatchObject({ resolution: 'raw' });
    expect(res.json().points).toHaveLength(3);
  });

  it('picks minute rollups once the raw readings in the range are too many to chart', async () => {
    const start = now - 3 * 60 * MIN;
    for (let ts = start; ts < now - 3 * MIN; ts += 5000) {
      insertSample(db, { ts, metric: 'cpu_load', value: 1 });
    }
    runHousekeeping(db, now);

    const res = await series(`from=${now - DAY}&to=${now}`);
    expect(res.json()).toMatchObject({ resolution: '1m' });
    expect(res.json().points.length).toBeLessThanOrEqual(180);
  });

  it('honours an explicit resolution', async () => {
    const res = await series(`from=${now - 10 * MIN}&to=${now}&resolution=1m`);
    expect(res.json()).toMatchObject({ resolution: '1m' });
  });

  it('defaults to the last 24 hours', async () => {
    const res = await series('');
    expect(res.json().points).toHaveLength(3);
  });

  it.each([
    ['an unknown resolution', 'resolution=5m'],
    ['from after to', `from=${now}&to=${now - MIN}`],
    ['a negative timestamp', 'from=-1']
  ])('rejects %s with 400', async (_case, query) => {
    expect((await series(query)).statusCode).toBe(400);
  });
});
