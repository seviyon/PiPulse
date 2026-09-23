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
/**
 * A fixed "now" on a local day boundary: midnight 2026-09-01 in the pinned
 * test timezone (Europe/Madrid, UTC+2 here), i.e. 2026-08-31T22:00Z.
 */
const T0 = new Date(2026, 8, 1).getTime();

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

describe('daily rollups follow local days', () => {
  it('runs under the pinned timezone', () => {
    expect(new Date(T0).toISOString()).toBe('2026-08-31T22:00:00.000Z');
  });

  it('starts each day at local midnight, not UTC midnight', () => {
    // 23:30 local on Sep 1 is 21:30Z the same day; 01:00 local on Sep 2 is 23:00Z on Sep 1.
    insertSample(db, { ts: new Date(2026, 8, 1, 23, 30).getTime(), metric: 'cpu_load', value: 2 });
    insertSample(db, { ts: new Date(2026, 8, 2, 1, 0).getTime(), metric: 'cpu_load', value: 8 });

    runHousekeeping(db, new Date(2026, 8, 3).getTime());

    expect(rollups('1d').map((r) => [new Date(r.ts).toString().slice(4, 24), r.avg])).toEqual([
      ['Sep 01 2026 00:00:00', 2],
      ['Sep 02 2026 00:00:00', 8]
    ]);
  });

  it('gives the day DST ends its full 25 hours', () => {
    // Europe/Madrid falls back on 2026-10-25: that local day is 25 hours long.
    const dayStart = new Date(2026, 9, 25).getTime();
    const nextDay = new Date(2026, 9, 26).getTime();
    expect(nextDay - dayStart).toBe(25 * HOUR);
    insertSample(db, { ts: dayStart + 30 * MIN, metric: 'cpu_load', value: 1 });
    insertSample(db, { ts: nextDay - 30 * MIN, metric: 'cpu_load', value: 3 });
    insertSample(db, { ts: nextDay + 30 * MIN, metric: 'cpu_load', value: 9 });

    runHousekeeping(db, nextDay + DAY);

    expect(rollups('1d')).toEqual([
      { ts: dayStart, avg: 2, min: 1, max: 3, count: 2 },
      { ts: nextDay, avg: 9, min: 9, max: 9, count: 1 }
    ]);
  });

  it('does not close a local day before local midnight', () => {
    insertSample(db, { ts: T0 + HOUR, metric: 'cpu_load', value: 1 });
    runHousekeeping(db, T0 + DAY - MIN);
    expect(rollups('1d')).toEqual([]);
  });
});

describe('daily rollups across a timezone change', () => {
  /** Runs `fn` with the server timezone set to `tz`, then restores the pinned one. */
  function inTimezone<T>(tz: string, fn: () => T): T {
    const pinned = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      process.env.TZ = pinned;
    }
  }

  const sample = (ts: number, value: number) => insertSample(db, { ts, metric: 'cpu_load', value });
  const totalCount = () => rollups('1d').reduce((sum, row) => sum + row.count, 0);

  it('picks up where the last day ended, without recounting or skipping hours', () => {
    sample(Date.UTC(2026, 8, 9, 12), 1);
    // After midnight UTC but before midnight in New York (04:00Z).
    sample(Date.UTC(2026, 8, 10, 2), 3);
    sample(Date.UTC(2026, 8, 10, 12), 5);

    inTimezone('UTC', () => runHousekeeping(db, Date.UTC(2026, 8, 10, 0, 30)));
    expect(rollups('1d').map((r) => [r.ts, r.avg])).toEqual([[Date.UTC(2026, 8, 9), 1]]);

    // Moving west: New York's Sep 9 began at 04:00Z, 20 hours of which the UTC day already counts.
    inTimezone('America/New_York', () => runHousekeeping(db, Date.UTC(2026, 8, 12, 12)));
    expect(rollups('1d').map((r) => [r.ts, r.avg])).toEqual([
      [Date.UTC(2026, 8, 9), 1],
      [Date.UTC(2026, 8, 9, 4), 3],
      [Date.UTC(2026, 8, 10, 4), 5]
    ]);
    expect(totalCount()).toBe(3);
  });

  it('merges into a day row the new timezone shares instead of overwriting it', () => {
    // Lagos (UTC+1 all year) and London's Oct 25 (the day BST ends, 25 hours
    // long) both start at 23:00Z on Oct 24, but Lagos's ends an hour sooner.
    sample(Date.UTC(2026, 9, 25, 12), 2);
    inTimezone('Africa/Lagos', () => runHousekeeping(db, Date.UTC(2026, 9, 25, 23, 30)));
    sample(Date.UTC(2026, 9, 25, 23, 30), 6);

    inTimezone('Europe/London', () => runHousekeeping(db, Date.UTC(2026, 9, 27, 12)));
    expect(rollups('1d')).toEqual([
      { ts: Date.UTC(2026, 9, 24, 23), avg: 4, min: 2, max: 6, count: 2 }
    ]);
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
