import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHistory, openDb, SCHEMA_VERSION } from '../src/index.js';

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
});
