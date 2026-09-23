import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHistory, openDb, runHousekeeping, SCHEMA_VERSION } from '../src/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-migrate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function indexes(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[])
    .map((i) => i.name)
    .filter((name) => !name.startsWith('sqlite_autoindex'));
}

/** A database as schema version 2 left it. */
function createV2(path: string): DatabaseSync {
  const v2 = new DatabaseSync(path);
  v2.exec(`
    CREATE TABLE metrics (ts INTEGER NOT NULL, metric TEXT NOT NULL, value REAL, PRIMARY KEY (metric, ts));
    CREATE TABLE metrics_rollup (ts INTEGER NOT NULL, metric TEXT NOT NULL, resolution TEXT NOT NULL,
      avg REAL, min REAL, max REAL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (metric, resolution, ts));
    CREATE INDEX idx_metrics_ts ON metrics(ts);
    CREATE INDEX idx_rollup_resolution_ts ON metrics_rollup(resolution, ts);
    PRAGMA user_version = 2;
  `);
  return v2;
}

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('schema migrations', () => {
  it('creates the current schema on a fresh database', () => {
    const db = openDb(':memory:');

    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(columns(db, 'metrics_rollup')).toContain('count');
    expect(indexes(db, 'metrics')).toEqual(['idx_metrics_ts']);
    expect(indexes(db, 'metrics_rollup')).toEqual(['idx_rollup_resolution_ts']);
    db.close();
  });

  it('upgrades a Phase 0–3 database in place, keeping its samples', () => {
    const path = join(dir, 'legacy.sqlite');
    // The exact schema databases were created with before versioning existed.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE metrics (ts INTEGER NOT NULL, metric TEXT NOT NULL, value REAL, PRIMARY KEY (metric, ts));
      CREATE INDEX idx_metrics_metric_ts ON metrics(metric, ts);
      CREATE TABLE metrics_rollup (ts INTEGER NOT NULL, metric TEXT NOT NULL, resolution TEXT NOT NULL,
        avg REAL, min REAL, max REAL, PRIMARY KEY (metric, resolution, ts));
      INSERT INTO metrics VALUES (1000, 'cpu_load', 12.5), (2000, 'cpu_load', 42);
    `);
    legacy.close();

    const db = openDb(path);

    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(columns(db, 'metrics_rollup')).toContain('count');
    // The old index duplicated the primary key; it is replaced by one on ts alone.
    expect(indexes(db, 'metrics')).toEqual(['idx_metrics_ts']);
    expect(getHistory(db, 'cpu_load', 0, 3000).map((s) => s.value)).toEqual([12.5, 42]);
    db.close();
  });

  it('is a no-op when the database is already current', () => {
    const path = join(dir, 'current.sqlite');
    openDb(path).close();
    const db = openDb(path);

    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(indexes(db, 'metrics')).toEqual(['idx_metrics_ts']);
    db.close();
  });

  it('refuses a database from a newer PiPulse instead of guessing at it', () => {
    const path = join(dir, 'future.sqlite');
    const future = new DatabaseSync(path);
    future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    future.close();

    expect(() => openDb(path)).toThrow(/newer PiPulse/);
  });

  it('migration 3 drops UTC-day rollups that minute data can rebuild on local days', () => {
    const path = join(dir, 'v2.sqlite');
    const v2 = createV2(path);
    const minuteStart = Date.UTC(2026, 8, 10, 12);
    const insert = v2.prepare('INSERT INTO metrics_rollup VALUES (?, ?, ?, 1, 1, 1, 1)');
    insert.run(minuteStart, 'cpu_load', '1m');
    // Long before minute data begins: nothing to rebuild it from, so it stays.
    insert.run(Date.UTC(2026, 7, 1), 'cpu_load', '1d');
    // Overlapping minute data: dropped, to be rebuilt on a local-day boundary.
    insert.run(Date.UTC(2026, 8, 10), 'cpu_load', '1d');
    insert.run(Date.UTC(2026, 8, 11), 'cpu_load', '1d');
    v2.close();

    const db = openDb(path);
    const days = (
      db.prepare("SELECT ts FROM metrics_rollup WHERE resolution = '1d' ORDER BY ts").all() as {
        ts: number;
      }[]
    ).map((row) => row.ts);

    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(days).toEqual([Date.UTC(2026, 7, 1)]);
    db.close();
  });

  it('migration 3 rebuilds the first local day from hourly rows where minute data starts mid-day', () => {
    const path = join(dir, 'v2.sqlite');
    const v2 = createV2(path);
    const insert = v2.prepare('INSERT INTO metrics_rollup VALUES (?, ?, ?, ?, ?, ?, ?)');
    const row = (ts: number, resolution: string, value: number, count: number) =>
      insert.run(ts, 'cpu_load', resolution, value, value, value, count);
    // Kept: its UTC day ends before minute data begins at 10:00Z on Sep 10.
    row(Date.UTC(2026, 8, 9), '1d', 100, 1440);
    // Dropped: overlaps minute data.
    row(Date.UTC(2026, 8, 10), '1d', 100, 1440);
    // Already counted by the kept UTC day, so left out of the rebuilt local day.
    row(Date.UTC(2026, 8, 9, 23), '1h', 100, 60);
    // Before minute data: stands in for the pruned minutes.
    row(Date.UTC(2026, 8, 10, 5), '1h', 2, 60);
    // Minute data covers this hour, so its hourly row isn't counted twice.
    row(Date.UTC(2026, 8, 10, 10), '1h', 50, 60);
    row(Date.UTC(2026, 8, 10, 10), '1m', 4, 60);
    // First minute of the next local day (Madrid midnight is 22:00Z): marks Sep 10 as final.
    row(Date.UTC(2026, 8, 10, 22), '1m', 7, 1);
    v2.close();

    const db = openDb(path);
    const days = db
      .prepare("SELECT ts, avg, count FROM metrics_rollup WHERE resolution = '1d' ORDER BY ts")
      .all();
    // Local Sep 10 (Europe/Madrid) starts at 22:00Z on Sep 9.
    expect(days).toEqual([
      { ts: Date.UTC(2026, 8, 9), avg: 100, count: 1440 },
      { ts: new Date(2026, 8, 10).getTime(), avg: 3, count: 120 }
    ]);
    expect(new Date(2026, 8, 10).getTime()).toBe(Date.UTC(2026, 8, 9, 22));

    // Housekeeping carries on from the next local day, from minutes alone.
    runHousekeeping(db, new Date(2026, 8, 12).getTime(), {
      raw: Infinity,
      '1m': Infinity,
      '1h': Infinity,
      '1d': Infinity
    });
    const after = db
      .prepare("SELECT ts, avg FROM metrics_rollup WHERE resolution = '1d' ORDER BY ts")
      .all();
    expect(after.at(-1)).toEqual({ ts: new Date(2026, 8, 11).getTime(), avg: 7 });
    expect(after).toHaveLength(3);
    db.close();
  });

  it('migration 3 keeps the hours before minute data in a day that has not ended', () => {
    const path = join(dir, 'v2.sqlite');
    const v2 = createV2(path);
    const insert = v2.prepare('INSERT INTO metrics_rollup VALUES (?, ?, ?, ?, ?, ?, ?)');
    const row = (ts: number, resolution: string, value: number, count: number) =>
      insert.run(ts, 'cpu_load', resolution, value, value, value, count);
    row(Date.UTC(2026, 8, 9), '1d', 100, 1440);
    // Minute data (retention under a day) starts at 10:00Z on Sep 10; only
    // the hourly row remembers 05:00Z.
    row(Date.UTC(2026, 8, 10, 5), '1h', 4, 2);
    row(Date.UTC(2026, 8, 10, 10), '1m', 1, 1);
    row(Date.UTC(2026, 8, 10, 11), '1m', 1, 1);
    v2.close();

    const db = openDb(path);
    const localSep10 = new Date(2026, 8, 10).getTime();
    const days = () =>
      db
        .prepare(
          "SELECT ts, avg, min, max, count FROM metrics_rollup WHERE resolution = '1d' ORDER BY ts"
        )
        .all();
    expect(days()).toEqual([
      { ts: Date.UTC(2026, 8, 9), avg: 100, min: 100, max: 100, count: 1440 },
      { ts: localSep10, avg: 4, min: 4, max: 4, count: 2 }
    ]);

    // At local midnight housekeeping merges the day's minutes in.
    runHousekeeping(db, new Date(2026, 8, 11).getTime(), {
      raw: Infinity,
      '1m': Infinity,
      '1h': Infinity,
      '1d': Infinity
    });
    expect(days()).toEqual([
      { ts: Date.UTC(2026, 8, 9), avg: 100, min: 100, max: 100, count: 1440 },
      { ts: localSep10, avg: 2.5, min: 1, max: 4, count: 4 }
    ]);
    db.close();
  });
});
