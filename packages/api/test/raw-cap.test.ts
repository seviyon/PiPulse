import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertSample, openDb, runHousekeeping, type PiPulseDb } from '@pipulse/storage';
import { buildServer } from '../src/index.js';
import { MAX_RAW_ROWS } from '@pipulse/storage';

const SECOND = 1000;

let db: PiPulseDb;
let now: number;

/** `count` readings, one per second, ending at `now`. */
function fill(count: number) {
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    insertSample(db, { ts: now - (count - 1 - i) * SECOND, metric: 'cpu_load', value: i });
  }
  db.exec('COMMIT');
}

const get = (url: string) => buildServer(db).inject({ method: 'GET', url });

beforeEach(() => {
  db = openDb(':memory:');
  now = Math.floor(Date.now() / 60_000) * 60_000;
});
afterEach(() => db.close());

describe('raw readings are bounded', () => {
  it('is 5000 rows', () => {
    expect(MAX_RAW_ROWS).toBe(5000);
  });

  it('serves a window of exactly the limit, from /history and from /series?resolution=raw', async () => {
    fill(MAX_RAW_ROWS);
    const range = `from=${now - MAX_RAW_ROWS * SECOND}&to=${now}`;
    const history = await get(`/api/metrics/cpu_load/history?${range}`);
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(MAX_RAW_ROWS);
    const series = await get(`/api/metrics/cpu_load/series?${range}&resolution=raw`);
    expect(series.statusCode).toBe(200);
    expect((series.json() as { points: unknown[] }).points).toHaveLength(MAX_RAW_ROWS);
  });

  it('refuses one row more with 400 and says what to do instead', async () => {
    fill(MAX_RAW_ROWS + 1);
    const range = `from=0&to=${now}`;
    for (const url of [
      `/api/metrics/cpu_load/history?${range}`,
      `/api/metrics/cpu_load/series?${range}&resolution=raw`
    ]) {
      const res = await get(url);
      expect(res.statusCode).toBe(400);
      const { error } = res.json() as { error: string };
      expect(error).toContain('5000');
      expect(error).toMatch(/shorter window/);
      expect(error).toContain('resolution=1m');
    }
  });

  it('counts only the asked window and the asked metric', async () => {
    fill(MAX_RAW_ROWS + 1);
    insertSample(db, { ts: now, metric: 'other', value: 1 });
    // The last 100 seconds of cpu_load is small, however big the table is.
    const small = await get(`/api/metrics/cpu_load/history?from=${now - 100 * SECOND}&to=${now}`);
    expect(small.statusCode).toBe(200);
    expect(small.json()).toHaveLength(101);
    const other = await get(`/api/metrics/other/history?from=0&to=${now}`);
    expect(other.statusCode).toBe(200);
  });

  it('does not limit rolled-up resolutions or auto', async () => {
    fill(MAX_RAW_ROWS + 1);
    runHousekeeping(db, now + 2 * 60_000);
    const range = `from=0&to=${now}`;
    const minutes = await get(`/api/metrics/cpu_load/series?${range}&resolution=1m`);
    expect(minutes.statusCode).toBe(200);
    const auto = await get(`/api/metrics/cpu_load/series?${range}`);
    expect(auto.statusCode).toBe(200);
    expect((auto.json() as { resolution: string }).resolution).not.toBe('raw');
  });
});
