import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseResolution,
  DEFAULT_RETENTION,
  getSeries,
  insertSample,
  openDb,
  runHousekeeping,
  type PiPulseDb
} from '../src/index.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A fixed "now" on a day boundary (2026-09-01T00:00Z) keeps bucket maths readable. */
const T0 = Date.UTC(2026, 8, 1);

let db: PiPulseDb;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function rollups(resolution: string, metric = 'cpu_load') {
  return db
    .prepare(
      'SELECT ts, avg, min, max, count FROM metrics_rollup WHERE metric = ? AND resolution = ? ORDER BY ts'
    )
    .all(metric, resolution) as {
    ts: number;
    avg: number;
    min: number;
    max: number;
    count: number;
  }[];
}

function rawCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM metrics').get() as { n: number }).n;
}

describe('runHousekeeping rollups', () => {
  it('rolls complete minutes of raw samples into 1m avg/min/max/count', () => {
    for (const [offset, value] of [
      [0, 10],
      [5000, 20],
      [55_000, 30],
      [MIN, 5],
      [MIN + 30_000, 7]
    ] as const) {
      insertSample(db, { ts: T0 + offset, metric: 'cpu_load', value });
    }
    // Still inside the minute that starts at T0 + 2 min: not complete yet.
    insertSample(db, { ts: T0 + 2 * MIN + 1000, metric: 'cpu_load', value: 99 });

    runHousekeeping(db, T0 + 2 * MIN + 30_000);

    expect(rollups('1m')).toEqual([
      { ts: T0, avg: 20, min: 10, max: 30, count: 3 },
      { ts: T0 + MIN, avg: 6, min: 5, max: 7, count: 2 }
    ]);
  });

  it('weights hourly averages by how many samples each minute holds', () => {
    // Minute 0: three samples of 10. Minute 1: one sample of 50.
    for (const offset of [0, 10_000, 20_000]) {
      insertSample(db, { ts: T0 + offset, metric: 'cpu_load', value: 10 });
    }
    insertSample(db, { ts: T0 + MIN, metric: 'cpu_load', value: 50 });

    runHousekeeping(db, T0 + HOUR + MIN);

    // (3 × 10 + 1 × 50) / 4 = 20, not the unweighted (10 + 50) / 2 = 30.
    expect(rollups('1h')).toEqual([{ ts: T0, avg: 20, min: 10, max: 50, count: 4 }]);
  });

  it('rolls hours into days once the day is complete', () => {
    insertSample(db, { ts: T0 + 3 * HOUR, metric: 'cpu_load', value: 4 });
    insertSample(db, { ts: T0 + 20 * HOUR, metric: 'cpu_load', value: 8 });

    runHousekeeping(db, T0 + DAY - MIN);
    expect(rollups('1d')).toEqual([]);

    runHousekeeping(db, T0 + DAY + MIN);
    expect(rollups('1d')).toEqual([{ ts: T0, avg: 6, min: 4, max: 8, count: 2 }]);
  });

  it('is idempotent and picks up new samples incrementally', () => {
    insertSample(db, { ts: T0, metric: 'cpu_load', value: 1 });
    runHousekeeping(db, T0 + 2 * MIN);
    runHousekeeping(db, T0 + 2 * MIN);
    expect(rollups('1m')).toHaveLength(1);

    insertSample(db, { ts: T0 + 2 * MIN, metric: 'cpu_load', value: 3 });
    runHousekeeping(db, T0 + 3 * MIN);
    expect(rollups('1m').map((r) => [r.ts, r.avg])).toEqual([
      [T0, 1],
      [T0 + 2 * MIN, 3]
    ]);
  });

  it('keeps metrics apart', () => {
    insertSample(db, { ts: T0, metric: 'cpu_load', value: 1 });
    insertSample(db, { ts: T0, metric: 'memory_used', value: 500 });
    runHousekeeping(db, T0 + MIN);

    expect(rollups('1m', 'cpu_load').map((r) => r.avg)).toEqual([1]);
    expect(rollups('1m', 'memory_used').map((r) => r.avg)).toEqual([500]);
  });
});

describe('runHousekeeping pruning', () => {
  it('drops raw samples past retention once they are rolled up', () => {
    insertSample(db, { ts: T0, metric: 'cpu_load', value: 1 });
    insertSample(db, { ts: T0 + 3 * DAY, metric: 'cpu_load', value: 2 });

    const result = runHousekeeping(db, T0 + 3 * DAY + HOUR);

    expect(result.pruned.raw).toBe(1);
    expect(getSeries(db, 'cpu_load', 0, Infinity, 'raw').map((p) => p.avg)).toEqual([2]);
    // The pruned sample survives in every rollup level.
    expect(rollups('1m').map((r) => r.ts)).toContain(T0);
    expect(rollups('1d').map((r) => r.ts)).toContain(T0);
  });

  it('never drops raw samples that are not rolled up yet', () => {
    insertSample(db, { ts: T0, metric: 'cpu_load', value: 1 });
    // A retention shorter than the minute bucket: the sample is "expired"
    // before its minute has closed, so it must wait.
    runHousekeeping(db, T0 + 30_000, { ...DEFAULT_RETENTION, raw: 1000 });
    expect(rawCount()).toBe(1);
  });

  it('applies each rollup level its own retention and keeps daily forever', () => {
    const start = T0 - 400 * DAY;
    insertSample(db, { ts: start, metric: 'cpu_load', value: 1 });
    runHousekeeping(db, T0);

    expect(rollups('1m')).toEqual([]);
    expect(rollups('1h')).toEqual([]);
    expect(rollups('1d').map((r) => r.ts)).toEqual([start]);
  });
});

describe('getSeries', () => {
  it('returns raw samples as points whose avg, min and max are the value', () => {
    insertSample(db, { ts: T0, metric: 'cpu_load', value: 7 });
    expect(getSeries(db, 'cpu_load', T0, T0, 'raw')).toEqual([{ ts: T0, avg: 7, min: 7, max: 7 }]);
  });

  it('returns rollup buckets within the range', () => {
    insertSample(db, { ts: T0, metric: 'cpu_load', value: 2 });
    insertSample(db, { ts: T0 + 30_000, metric: 'cpu_load', value: 4 });
    runHousekeeping(db, T0 + MIN);

    expect(getSeries(db, 'cpu_load', T0, T0 + MIN, '1m')).toEqual([
      { ts: T0, avg: 3, min: 2, max: 4 }
    ]);
  });
});

describe('chooseResolution', () => {
  const now = T0;
  it.each([
    [HOUR, 'raw'],
    [DAY, '1m'],
    [7 * DAY, '1h'],
    [30 * DAY, '1h'],
    [90 * DAY, '1d'],
    [365 * DAY, '1d']
  ])('picks the finest resolution that keeps a %i ms view under ~1500 points: %s', (span, res) => {
    expect(chooseResolution(now - span, now, now)).toBe(res);
  });

  it('skips a resolution whose retention no longer covers the start of the range', () => {
    // A one-hour window three days ago: raw is gone (2-day retention), 1m remains.
    expect(chooseResolution(now - 3 * DAY, now - 3 * DAY + HOUR, now)).toBe('1m');
  });
});

describe('Phase 4 exit criterion', () => {
  it('serves a year of history from daily rollups without reading the raw table', () => {
    // A year of hourly samples (the densest data a year-old install keeps).
    const insert = db.prepare('INSERT INTO metrics (ts, metric, value) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    for (let ts = T0 - 365 * DAY; ts < T0; ts += HOUR) {
      insert.run(ts, 'cpu_load', (ts / HOUR) % 100);
    }
    db.exec('COMMIT');
    runHousekeeping(db, T0);

    const from = T0 - 365 * DAY;
    const resolution = chooseResolution(from, T0, T0);
    const points = getSeries(db, 'cpu_load', from, T0, resolution);

    expect(resolution).toBe('1d');
    expect(points).toHaveLength(365);
    const plan = (
      db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT ts, avg, min, max FROM metrics_rollup WHERE metric = ? AND resolution = ? AND ts BETWEEN ? AND ? ORDER BY ts'
        )
        .all('cpu_load', '1d', from, T0) as { detail: string }[]
    ).map((row) => row.detail);
    expect(plan.join(' ')).toMatch(/SEARCH metrics_rollup USING (INDEX|PRIMARY KEY)/);
    expect(plan.join(' ')).not.toMatch(/\bmetrics\b(?!_rollup)/);
  });
});
