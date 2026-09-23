import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertSample, openDb, type PiPulseDb } from '@pipulse/storage';
import {
  clearAlert,
  latestReading,
  latestRollup,
  listAlerts,
  openAlerts,
  raiseAlert,
  summarizeWindow,
  WINDOW_SQL
} from '../src/index.js';

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const base = {
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  severity: 'critical' as const,
  message: 'CPU running hot',
  value: 82
};

describe('latestRollup', () => {
  it('returns the newest bucket at the finest level that has one', () => {
    const add = (ts: number, resolution: string, avg: number) =>
      db
        .prepare(
          'INSERT INTO metrics_rollup (ts, metric, resolution, avg, min, max) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(ts, 'disk_used', resolution, avg, avg, avg);
    expect(latestRollup(db, 'disk_used')).toBeNull();
    add(0, '1d', 40);
    add(3_600_000, '1h', 41);
    expect(latestRollup(db, 'disk_used')).toEqual({ ts: 3_600_000, value: 41 });
    add(3_600_000, '1m', 42);
    add(3_660_000, '1m', 43);
    expect(latestRollup(db, 'disk_used')).toEqual({ ts: 3_660_000, value: 43 });
    expect(latestRollup(db, 'cpu_load')).toBeNull();
  });
});

describe('summarizeWindow', () => {
  it('summarises one metric in the window, counting readings with the bits', () => {
    for (const [ts, value] of [
      [1000, 0],
      [2000, 5],
      [3000, 0x50000],
      [9000, 99]
    ] as const) {
      insertSample(db, { ts, metric: 'throttled', value });
    }
    insertSample(db, { ts: 2000, metric: 'cpu_load', value: 50 });
    expect({ ...summarizeWindow(db, 'throttled', 1000, 3000, 0xf) }).toEqual({
      count: 3,
      oldest: 1000,
      newest: 3000,
      min: 0,
      max: 0x50000,
      withBits: 1,
      maxGap: 1000
    });
    expect(summarizeWindow(db, 'throttled', 1000, 9000).maxGap).toBe(6000);
    expect(summarizeWindow(db, 'throttled', 8000, 9000).maxGap).toBeNull();
    expect({ ...summarizeWindow(db, 'throttled', 4000, 5000) }).toEqual({
      count: 0,
      oldest: null,
      newest: null,
      min: null,
      max: null,
      withBits: 0,
      maxGap: null
    });
  });

  it('seeks the primary key rather than scanning readings', () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${WINDOW_SQL}`).all(0, 'x', 0, 1) as {
      detail: string;
    }[];
    expect(plan.map((row) => row.detail).join('\n')).toMatch(
      /SEARCH metrics USING .*INDEX sqlite_autoindex_metrics_1 \(metric=\? AND ts>\? AND ts<\?\)/
    );
  });
});

describe('latestReading', () => {
  it('returns the newest reading, or null for a metric never stored', () => {
    insertSample(db, { ts: 1000, metric: 'disk_used', value: 40 });
    insertSample(db, { ts: 5000, metric: 'disk_used', value: 41 });
    expect({ ...latestReading(db, 'disk_used') }).toEqual({ ts: 5000, value: 41 });
    expect(latestReading(db, 'throttled')).toBeNull();
  });
});

describe('alert rows', () => {
  it('raise, list open, clear, and list history newest first', () => {
    const first = raiseAlert(db, { ...base, raisedAt: 1000 });
    const second = raiseAlert(db, {
      ...base,
      ruleId: 'disk_full',
      metric: 'disk_used',
      value: 93,
      raisedAt: 2000
    });
    expect({ ...first }).toEqual({
      id: first.id,
      ...base,
      raisedAt: 1000,
      clearedAt: null,
      clearedBy: null
    });
    expect(openAlerts(db).map((a) => a.ruleId)).toEqual(['disk_full', 'cpu_hot']);

    const cleared = clearAlert(db, first.id, 3000, 'condition');
    expect(cleared).toMatchObject({ clearedAt: 3000, clearedBy: 'condition' });
    expect(openAlerts(db).map((a) => a.id)).toEqual([second.id]);
    expect(
      listAlerts(db, { state: 'all', from: 0, to: 10_000, limit: 10 }).map((a) => a.id)
    ).toEqual([second.id, first.id]);
    expect(
      listAlerts(db, { state: 'active', from: 0, to: 10_000, limit: 10 }).map((a) => a.id)
    ).toEqual([second.id]);
    expect(
      listAlerts(db, { state: 'cleared', from: 0, to: 10_000, limit: 10 }).map((a) => a.id)
    ).toEqual([first.id]);
    expect(listAlerts(db, { state: 'cleared', from: 3500, to: 10_000, limit: 10 })).toEqual([]);
    // Raised before the window but cleared inside it: it was active in the window.
    expect(
      listAlerts(db, { state: 'cleared', from: 2500, to: 10_000, limit: 10 }).map((a) => a.id)
    ).toEqual([first.id]);
    expect(
      listAlerts(db, { state: 'all', from: 2500, to: 10_000, limit: 10 }).map((a) => a.id)
    ).toEqual([second.id, first.id]);
    expect(listAlerts(db, { state: 'all', from: 0, to: 10_000, limit: 1 })).toHaveLength(1);
  });

  it('lists an alert still open however long ago it was raised', () => {
    const old = raiseAlert(db, { ...base, raisedAt: 1000 });
    expect(
      listAlerts(db, { state: 'all', from: 50_000, to: 60_000, limit: 10 }).map((a) => a.id)
    ).toEqual([old.id]);
  });
});
