import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema migrations. Migration N brings a database from
 * `PRAGMA user_version` N-1 to N; each runs in its own transaction.
 * Append new ones — never edit one that has shipped.
 */
const migrations: ((db: DatabaseSync) => void)[] = [
  // 1: the baseline schema. IF NOT EXISTS because databases created before
  // versioning existed already have these tables at user_version 0.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        ts     INTEGER NOT NULL,
        metric TEXT NOT NULL,
        value  REAL,
        PRIMARY KEY (metric, ts)
      );
      CREATE TABLE IF NOT EXISTS metrics_rollup (
        ts         INTEGER NOT NULL,
        metric     TEXT NOT NULL,
        resolution TEXT NOT NULL,
        avg        REAL,
        min        REAL,
        max        REAL,
        PRIMARY KEY (metric, resolution, ts)
      );
    `);
  },
  // 2: rollups record how many samples each bucket averages, so coarser
  // levels can weight finer ones correctly. The old (metric, ts) index
  // duplicated the primary key; the rollup job and pruning query by time
  // across all metrics, which needs ts-leading indexes instead.
  (db) => {
    db.exec(`
      ALTER TABLE metrics_rollup ADD COLUMN count INTEGER NOT NULL DEFAULT 1;
      DROP INDEX IF EXISTS idx_metrics_metric_ts;
      CREATE INDEX idx_metrics_ts ON metrics(ts);
      CREATE INDEX idx_rollup_resolution_ts ON metrics_rollup(resolution, ts);
    `);
  }
];

export const SCHEMA_VERSION = migrations.length;

/** Brings `db` up to SCHEMA_VERSION. Throws on a database from a newer PiPulse. */
export function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is from a newer PiPulse (this one supports ${SCHEMA_VERSION}); upgrade PiPulse instead`
    );
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    db.exec('BEGIN');
    try {
      migrations[version - 1]!(db);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
