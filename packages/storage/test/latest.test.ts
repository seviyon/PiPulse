import { describe, expect, it } from 'vitest';
import { LATEST_SQL, getLatest, insertSample, openDb } from '../src/index.js';

const MIN = 60_000;

/** The straightforward query getLatest used to be: right, but it scans every raw row. */
const reference = (db: ReturnType<typeof openDb>, limit: number) =>
  db
    .prepare(
      `SELECT m.ts AS ts, m.metric AS metric, m.value AS value
       FROM metrics m
       JOIN (SELECT metric, MAX(ts) AS ts FROM metrics WHERE ts <= ? GROUP BY metric) l
         ON l.metric = m.metric AND l.ts = m.ts`
    )
    .all(limit);

const sorted = <T extends { metric: string }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.metric < b.metric ? -1 : 1));

describe('getLatest', () => {
  it('is empty on an empty database', () => {
    expect(getLatest(openDb(':memory:'))).toEqual([]);
    expect(getLatest(openDb(':memory:'), Date.now())).toEqual([]);
  });

  it('returns the newest reading of each metric, however many each has', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 50; i++) insertSample(db, { ts: 1_000 + i, metric: 'a', value: i });
    insertSample(db, { ts: 5, metric: 'b', value: 1 });
    insertSample(db, { ts: 6, metric: 'b', value: 2 });
    insertSample(db, { ts: 9, metric: 'c', value: 3 });
    expect(sorted(getLatest(db))).toEqual([
      { ts: 1_049, metric: 'a', value: 49 },
      { ts: 6, metric: 'b', value: 2 },
      { ts: 9, metric: 'c', value: 3 }
    ]);
  });

  it('leaves out a metric whose readings are all in the future, and uses its older one otherwise', () => {
    const db = openDb(':memory:');
    const now = 10_000_000;
    insertSample(db, { ts: now - MIN, metric: 'old_then_future', value: 1 });
    insertSample(db, { ts: now + 10 * MIN, metric: 'old_then_future', value: 99 });
    insertSample(db, { ts: now + 10 * MIN, metric: 'only_future', value: 5 });
    insertSample(db, { ts: now + MIN, metric: 'within_slack', value: 7 });
    expect(sorted(getLatest(db, now))).toEqual(
      [
        { ts: now + MIN, metric: 'within_slack', value: 7 },
        { ts: now - MIN, metric: 'old_then_future', value: 1 }
      ].sort((a, b) => (a.metric < b.metric ? -1 : 1))
    );
  });

  it('agrees with the plain query on many metrics, with and without a limit', () => {
    const db = openDb(':memory:');
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const names = ['cpu_load', 'load_1', 'disk_used', 'a_', 'Zeta', 'metric.with.dots', 'ü'];
    db.exec('BEGIN');
    for (const metric of names) {
      const n = 1 + Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) {
        insertSample(db, { ts: Math.floor(rand() * 1_000_000), metric, value: rand() });
      }
    }
    db.exec('COMMIT');
    for (const now of [undefined, 400_000, 0, 5_000_000]) {
      const limit = now === undefined ? Number.MAX_SAFE_INTEGER : now + 5 * MIN;
      expect(sorted(getLatest(db, now))).toEqual(sorted(reference(db, limit) as never[]));
    }
  });

  it('seeks per metric instead of scanning the readings', () => {
    const db = openDb(':memory:');
    insertSample(db, { ts: 1, metric: 'a', value: 1 });
    // The statement getLatest runs, as the plan SQLite makes for it.
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${LATEST_SQL}`)
      .all(Number.MAX_SAFE_INTEGER)
      .map((row) => String((row as { detail: string }).detail));
    expect(plan.some((line) => /^SCAN (m|metrics)\b/.test(line))).toBe(false);
  });
});
