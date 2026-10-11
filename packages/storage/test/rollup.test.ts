import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseResolution,
  DEFAULT_RETENTION,
  getLatest,
  getSeries,
  insertSample,
  openDb,
  runHousekeeping,
  startHousekeeping,
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
  it('returns raw samples as points whose avg, min and max are the value, counting one sample', () => {
    insertSample(db, { ts: T0, metric: 'cpu_load', value: 7 });
    expect(getSeries(db, 'cpu_load', T0, T0, 'raw')).toEqual([
      { ts: T0, avg: 7, min: 7, max: 7, count: 1 }
    ]);
  });

  it('returns rollup buckets within the range, with how many samples each averages', () => {
    insertSample(db, { ts: T0, metric: 'cpu_load', value: 2 });
    insertSample(db, { ts: T0 + 30_000, metric: 'cpu_load', value: 4 });
    runHousekeeping(db, T0 + MIN);

    expect(getSeries(db, 'cpu_load', T0, T0 + MIN, '1m')).toEqual([
      { ts: T0, avg: 3, min: 2, max: 4, count: 2 }
    ]);
  });
});

describe('chooseResolution', () => {
  const now = T0;
  const rollupInsert = () =>
    db.prepare(
      'INSERT INTO metrics_rollup (ts, metric, resolution, avg, min, max, count) VALUES (?, ?, ?, 1, 1, 1, 1)'
    );

  /** Rows for cpu_load at `step` from `since` up to `until`, raw or rolled up. */
  function fill(resolution: string, step: number, since: number, until = now) {
    const raw = db.prepare('INSERT INTO metrics (ts, metric, value) VALUES (?, ?, 1)');
    const rollup = rollupInsert();
    db.exec('BEGIN');
    for (let ts = since; ts < until; ts += step) {
      if (resolution === 'raw') raw.run(ts, 'cpu_load');
      else rollup.run(ts, 'cpu_load', resolution);
    }
    db.exec('COMMIT');
  }

  /** What default retention leaves behind after a year of 5 s polling. */
  function matureDatabase() {
    fill('raw', 5000, now - 2 * DAY);
    fill('1m', MIN, now - 14 * DAY);
    fill('1h', HOUR, now - 365 * DAY);
    fill('1d', DAY, now - 365 * DAY);
  }

  it.each([
    [HOUR, 'raw'],
    [DAY, '1m'],
    [7 * DAY, '1h'],
    [30 * DAY, '1h'],
    [90 * DAY, '1d'],
    [365 * DAY, '1d']
  ])(
    'on a mature database, picks the finest resolution that keeps a %i ms view under ~1500 points: %s',
    (span, res) => {
      matureDatabase();
      expect(chooseResolution(db, 'cpu_load', now - span, now, now)).toBe(res);
    }
  );

  it('skips a resolution whose retention no longer covers the start of the range', () => {
    matureDatabase();
    // A one-hour window three days ago: raw is gone (2-day retention), 1m remains.
    expect(chooseResolution(db, 'cpu_load', now - 3 * DAY, now - 3 * DAY + HOUR, now)).toBe('1m');
  });

  it('does not pick a level whose retention ends inside the window, even if its rows fit', () => {
    matureDatabase();
    // One hour straddling raw's 2-day edge: raw holds only its last 30 minutes.
    const from = now - 2 * DAY - 30 * MIN;
    expect(chooseResolution(db, 'cpu_load', from, from + HOUR, now)).toBe('1m');
  });

  it('shows the readings so far for 7 days on a database too new for any hourly rollup', () => {
    fill('raw', 5000, now - 50 * MIN);
    fill('1m', MIN, now - 50 * MIN, now - MIN);

    const resolution = chooseResolution(db, 'cpu_load', now - 7 * DAY, now, now);
    expect(resolution).toBe('raw');
    expect(getSeries(db, 'cpu_load', now - 7 * DAY, now, resolution)).toHaveLength(600);
  });

  it('falls back to minutes once the raw readings no longer fit', () => {
    fill('raw', 5000, now - 3 * HOUR);
    fill('1m', MIN, now - 3 * HOUR, now - MIN);
    fill('1h', HOUR, now - 3 * HOUR, now - HOUR);

    expect(chooseResolution(db, 'cpu_load', now - 7 * DAY, now, now)).toBe('1m');
  });

  it('prefers finer data a young database has in full over a handful of coarse points', () => {
    // One day old: a year's view gets its 1440 minutes, not one daily point.
    fill('raw', 5000, now - DAY);
    fill('1m', MIN, now - DAY);
    fill('1h', HOUR, now - DAY);
    fill('1d', DAY, now - DAY);

    expect(chooseResolution(db, 'cpu_load', now - 365 * DAY, now, now)).toBe('1m');
  });

  it('decides per metric, so a slower-polled metric can stay finer', () => {
    matureDatabase();
    const raw = db.prepare("INSERT INTO metrics (ts, metric, value) VALUES (?, 'disk_used', 1)");
    for (let ts = now - DAY; ts < now; ts += MIN) raw.run(ts);

    expect(chooseResolution(db, 'cpu_load', now - DAY, now, now)).toBe('1m');
    expect(chooseResolution(db, 'disk_used', now - DAY, now, now)).toBe('raw');
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
    const resolution = chooseResolution(db, 'cpu_load', from, T0, T0);
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

describe('alert history pruning', () => {
  it('deletes cleared alerts older than a year and keeps open ones however old', () => {
    const insert = db.prepare(
      "INSERT INTO alerts (rule_id, metric, severity, message, raised_at, cleared_at) VALUES (?, 'cpu_load', 'warning', 'm', ?, ?)"
    );
    insert.run('old_cleared', T0 - 400 * DAY, T0 - 399 * DAY);
    insert.run('recent_cleared', T0 - 10 * DAY, T0 - 9 * DAY);
    insert.run('old_open', T0 - 400 * DAY, null);

    expect(runHousekeeping(db, T0).alertsPruned).toBe(1);
    const left = db.prepare('SELECT rule_id AS id FROM alerts ORDER BY id').all() as {
      id: string;
    }[];
    expect(left.map((row) => row.id)).toEqual(['old_open', 'recent_cleared']);
  });
});

describe('a clock that jumps forward and comes back (no RTC, bad NTP)', () => {
  /** One sample per minute for `minutes`, from `from`. */
  function feed(from: number, minutes: number, value = 1) {
    for (let i = 0; i < minutes; i++)
      insertSample(db, { ts: from + i * MIN, metric: 'cpu_load', value });
  }
  const minutesRolled = () =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM metrics_rollup WHERE resolution = '1m'").get() as {
        n: number;
      }
    ).n;

  /** A day of readings, a jump 30 days ahead for 5 minutes, then three more days at the right time. */
  function scenario() {
    feed(T0, 24 * 60); // day 1, real
    runHousekeeping(db, T0 + DAY);
    const future = T0 + DAY + 30 * DAY;
    feed(future, 5, 99); // the clock reads 30 days ahead for 5 minutes
    runHousekeeping(db, future + 5 * MIN);
    // the clock is corrected; three real days follow, with housekeeping every hour
    const resume = T0 + DAY + 5 * MIN;
    feed(resume, 3 * 24 * 60);
    for (let at = resume; at <= resume + 3 * DAY; at += HOUR) runHousekeeping(db, at);
    return { resume, end: resume + 3 * DAY };
  }

  it('keeps rolling the real data up, instead of waiting for time to catch up with the future rows', () => {
    const { resume, end } = scenario();
    const real = db
      .prepare(
        "SELECT COUNT(*) AS n FROM metrics_rollup WHERE resolution = '1m' AND ts >= ? AND ts < ?"
      )
      .get(resume, end - 2 * MIN) as { n: number };
    expect(real.n).toBeGreaterThanOrEqual(3 * 24 * 60 - 120);
    expect(minutesRolled()).toBeGreaterThan(3 * 24 * 60);
  });

  it('never prunes a raw sample that no rollup covers: every minute whose raw samples are gone is rolled up', () => {
    const { resume, end } = scenario();
    // Raw retention is 2 days, so the first real day's samples are gone by now.
    const gone = db
      .prepare('SELECT COUNT(*) AS n FROM metrics WHERE ts >= ? AND ts < ?')
      .get(resume, end - 2 * DAY - HOUR) as { n: number };
    expect(gone.n).toBe(0);
    const expected = Math.floor((end - 2 * DAY - HOUR - resume) / MIN);
    const rolled = db
      .prepare(
        "SELECT COUNT(*) AS n FROM metrics_rollup WHERE resolution = '1m' AND ts >= ? AND ts < ?"
      )
      .get(resume, end - 2 * DAY - HOUR) as { n: number };
    expect(rolled.n).toBeGreaterThanOrEqual(expected - 1);
  });

  describe('the housekeeping loop does not believe a clock that jumps ahead and comes back', () => {
    // Drives startHousekeeping with a clock the test moves; each tick of its timer is one run.
    function run(steps: { wall: number; mono: number }[]) {
      vi.useFakeTimers();
      let step = 0;
      const clock = () => steps[Math.min(step, steps.length - 1)]!;
      const h = startHousekeeping(db, {
        intervalMs: MIN,
        vacuum: false,
        now: () => clock().wall,
        monotonic: () => clock().mono
      });
      for (step = 1; step < steps.length; step++) vi.advanceTimersByTime(MIN);
      h.stop();
      vi.useRealTimers();
    }
    afterEach(() => vi.useRealTimers());

    it('leaves the days after the jump to roll up as they happen: nothing is marked done in advance', () => {
      feed(T0, 3 * 24 * 60); // three real days
      const steps: { wall: number; mono: number }[] = [];
      let mono = 0;
      // Real time up to the end of day 2, then 5 minutes reading 30 days ahead, then real time again.
      for (let at = T0 + 2 * DAY - 3 * MIN; at < T0 + 2 * DAY; at += MIN, mono += MIN)
        steps.push({ wall: at, mono });
      for (let i = 0; i < 5; i++, mono += MIN)
        steps.push({ wall: T0 + 2 * DAY + 30 * DAY + i * MIN, mono });
      for (
        let at = T0 + 2 * DAY + 5 * MIN;
        at <= T0 + 3 * DAY + 10 * MIN;
        at += 30 * MIN, mono += 30 * MIN
      )
        steps.push({ wall: at, mono });
      run(steps);
      const progress = db
        .prepare("SELECT until FROM rollup_progress WHERE resolution = '1d'")
        .get() as { until: number };
      expect(progress.until).toBeLessThanOrEqual(T0 + 3 * DAY + DAY); // never a day that has not happened
      const days = rollups('1d').map((d) => d.ts);
      expect(days).toContain(T0 + 2 * DAY); // day 3 rolled up once it ended, after the jump
      expect(days.some((d) => d > T0 + 4 * DAY)).toBe(false);
      for (const day of rollups('1d')) expect(day.count).toBeLessThanOrEqual(25 * 60);
    });

    it('believes a jump that stays, after fifteen minutes', () => {
      feed(T0, 24 * 60);
      const steps: { wall: number; mono: number }[] = [{ wall: T0 + DAY, mono: 0 }];
      for (let i = 1; i <= 20; i++)
        steps.push({ wall: T0 + DAY + 30 * DAY + i * MIN, mono: i * MIN });
      run(steps);
      const progress = db
        .prepare("SELECT until FROM rollup_progress WHERE resolution = '1d'")
        .get() as { until: number };
      expect(progress.until).toBeGreaterThan(T0 + 20 * DAY); // the new time was accepted
    });

    it('does not mind a clock that goes back or an ordinary run', () => {
      feed(T0, 24 * 60);
      run([
        { wall: T0 + DAY, mono: 0 },
        { wall: T0 + DAY - 2 * HOUR, mono: MIN },
        { wall: T0 + DAY + MIN, mono: 2 * MIN }
      ]);
      expect(rollups('1m').length).toBeGreaterThan(24 * 60 - 5);
    });
  });
});

describe('getLatest and a clock that was ahead', () => {
  it('ignores a reading stamped in the future, and takes the newest one that is not', () => {
    const now = T0 + DAY;
    insertSample(db, { ts: now - MIN, metric: 'cpu_load', value: 7 });
    insertSample(db, { ts: now + 30 * DAY, metric: 'cpu_load', value: 99 }); // stamped by a clock that read 30 days ahead
    expect(getLatest(db, now)).toEqual([{ ts: now - MIN, metric: 'cpu_load', value: 7 }]);
    // Without a clock to judge by, it is the newest by timestamp, as before.
    expect(getLatest(db)[0]?.value).toBe(99);
  });

  it('allows a few minutes of drift between the collector and the reader', () => {
    const now = T0 + DAY;
    insertSample(db, { ts: now + 2 * MIN, metric: 'cpu_load', value: 5 });
    expect(getLatest(db, now)).toHaveLength(1);
  });
});
