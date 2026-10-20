import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SERIES_ROWS, openDb, type PiPulseDb, type Resolution } from '@pipulse/storage';
import { buildServer } from '../src/index.js';

const MINUTE = 60_000;

let db: PiPulseDb;
let now: number;

/** `count` rolled-up rows of `cpu_load` at `resolution`, one per minute, ending at `now`. */
function fill(resolution: Exclude<Resolution, 'raw'>, count: number, metric = 'cpu_load') {
  const insert = db.prepare(
    'INSERT INTO metrics_rollup (ts, metric, resolution, avg, min, max) VALUES (?, ?, ?, 1, 1, 1)'
  );
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) insert.run(now - (count - 1 - i) * MINUTE, metric, resolution);
  db.exec('COMMIT');
}

const get = (url: string) => buildServer(db).inject({ method: 'GET', url });
const series = (resolution: string, from = 0, metric = 'cpu_load') =>
  get(`/api/metrics/${metric}/series?from=${from}&to=${now}&resolution=${resolution}`);

beforeEach(() => {
  db = openDb(':memory:');
  now = Math.floor(Date.now() / MINUTE) * MINUTE;
});
afterEach(() => db.close());

describe('rolled-up series are bounded like raw ones', () => {
  it('is 10000 rows', () => {
    expect(MAX_SERIES_ROWS).toBe(10_000);
  });

  it.each(['1m', '1h', '1d'] as const)(
    'serves exactly the limit at resolution=%s',
    async (resolution) => {
      fill(resolution, MAX_SERIES_ROWS);
      const res = await series(resolution);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { points: unknown[] }).points).toHaveLength(MAX_SERIES_ROWS);
    }
  );

  it.each(['1m', '1h', '1d'] as const)(
    'refuses one row more at resolution=%s with 400 and says what to do instead',
    async (resolution) => {
      fill(resolution, MAX_SERIES_ROWS + 1);
      const res = await series(resolution);
      expect(res.statusCode).toBe(400);
      const { error } = res.json() as { error: string };
      expect(error).toContain('10000');
      expect(error).toContain(resolution);
      expect(error).toMatch(/shorter window/);
      expect(error).toMatch(/coarser|auto/);
    }
  );

  it('counts only the asked window, the asked resolution and the asked metric', async () => {
    fill('1m', MAX_SERIES_ROWS + 1);
    fill('1m', MAX_SERIES_ROWS + 1, 'other');
    // The last hour of cpu_load is small, however big the table is.
    const small = await series('1m', now - 60 * MINUTE);
    expect(small.statusCode).toBe(200);
    expect((small.json() as { points: unknown[] }).points).toHaveLength(61);
    // Another resolution of the same metric holds nothing.
    const hourly = await series('1h');
    expect(hourly.statusCode).toBe(200);
    expect((hourly.json() as { points: unknown[] }).points).toHaveLength(0);
  });

  it('does not turn auto away: it picks a resolution that fits', async () => {
    fill('1m', MAX_SERIES_ROWS + 1);
    const res = await get(`/api/metrics/cpu_load/series?from=0&to=${now}&resolution=auto`);
    expect(res.statusCode).toBe(200);
  });
});
