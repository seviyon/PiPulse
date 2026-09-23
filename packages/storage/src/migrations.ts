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
  },
  // 3: daily rollups move from UTC days to the server's local days, built
  // from 1-minute rollups, and record in rollup_progress where they stopped
  // (a local day's end depends on the timezone it was cut in, so the newest
  // row can't say). Daily rows that minute data overlaps are dropped and
  // rebuilt on local days; older ones have no finer data left, so they stay
  // on their UTC days rather than being lost.
  //
  // Minute data starts partway through a day (pruning cuts mid-day), so the
  // rebuild takes hourly rows up to where minute data takes over; otherwise,
  // once hourly retention passed, daily history would keep a partial day
  // forever. It starts where the newest kept UTC day ends, so no hour is
  // counted twice, and stops at the last local midnight minute data has
  // reached. If minute data starts in a day that hasn't ended, the rebuild
  // still takes that day's hours before it, and housekeeping merges the
  // rest in at midnight. The day helpers and merge are inlined, not imported
  // from rollup.ts, because a shipped migration must not change behaviour
  // when that does.
  (db) => {
    db.exec(`
      CREATE TABLE rollup_progress (
        resolution TEXT PRIMARY KEY,
        until      INTEGER NOT NULL
      );
    `);
    const MIN = 60_000;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;
    const one = (sql: string) => (db.prepare(sql).get() as { ts: number | null }).ts;
    const setProgress = (until: number) =>
      db.prepare("INSERT INTO rollup_progress (resolution, until) VALUES ('1d', ?)").run(until);

    const firstMinute = one("SELECT MIN(ts) AS ts FROM metrics_rollup WHERE resolution = '1m'");
    if (firstMinute === null) {
      const newestDay = one("SELECT MAX(ts) AS ts FROM metrics_rollup WHERE resolution = '1d'");
      if (newestDay !== null) setProgress(newestDay + DAY);
      return;
    }
    db.prepare("DELETE FROM metrics_rollup WHERE resolution = '1d' AND ts > ?").run(
      firstMinute - DAY
    );

    const localDayStart = (ts: number) => {
      const date = new Date(ts);
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    };
    const nextLocalDay = (dayStart: number) => {
      const date = new Date(dayStart);
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    };
    const newestDay = one("SELECT MAX(ts) AS ts FROM metrics_rollup WHERE resolution = '1d'");
    const firstHour = one("SELECT MIN(ts) AS ts FROM metrics_rollup WHERE resolution = '1h'");
    const newestHour = one("SELECT MAX(ts) AS ts FROM metrics_rollup WHERE resolution = '1h'");
    const lastMinute = one("SELECT MAX(ts) AS ts FROM metrics_rollup WHERE resolution = '1m'")!;

    // Kept UTC days cover [ts, ts + 24h); a kept day always ends before
    // minute data begins.
    const start =
      newestDay !== null
        ? newestDay + DAY
        : localDayStart(Math.min(firstMinute, firstHour ?? firstMinute));
    // Hourly rows stand in for minutes up to the end of the hour holding the
    // first minute row (its earlier minutes were pruned), provided that hour
    // has closed; if it hasn't, none of its minutes were pruned.
    const firstFullHour = Math.ceil(firstMinute / HOUR) * HOUR;
    const hoursUntil =
      newestHour !== null && newestHour + HOUR >= firstFullHour ? firstFullHour : firstMinute;
    // Minute rows only exist for closed minutes, so all of them are final.
    const minutesUntil = lastMinute + MIN;
    const end = Math.min(Math.max(localDayStart(minutesUntil), hoursUntil), minutesUntil);
    if (start >= end) {
      if (newestDay !== null) setProgress(start);
      return;
    }

    const rebuild = db.prepare(
      `INSERT INTO metrics_rollup (ts, metric, resolution, avg, min, max, count)
       SELECT ?, metric, '1d', SUM(avg * count) / SUM(count), MIN(min), MAX(max), SUM(count)
       FROM metrics_rollup
       WHERE (resolution = '1h' AND ts >= ? AND ts < ?) OR (resolution = '1m' AND ts >= ? AND ts < ?)
       GROUP BY metric
       ON CONFLICT (metric, resolution, ts) DO UPDATE SET
         avg = (avg * count + excluded.avg * excluded.count) / (count + excluded.count),
         min = MIN(min, excluded.min),
         max = MAX(max, excluded.max),
         count = count + excluded.count`
    );
    for (let from = start; from < end;) {
      const day = localDayStart(from);
      const to = Math.min(nextLocalDay(day), end);
      rebuild.run(day, from, Math.min(hoursUntil, to), Math.max(from, hoursUntil), to);
      from = to;
    }
    setProgress(end);
  },
  // 4: alerts raised and cleared by the alert engine (packages/alerts). At
  // most one open alert per rule and metric: a "*" rule watches every
  // metric, so two silent metrics are two alerts. Housekeeping prunes
  // cleared alerts after a year.
  (db) => {
    db.exec(`
      CREATE TABLE alerts (
        id         INTEGER PRIMARY KEY,
        rule_id    TEXT NOT NULL,
        metric     TEXT NOT NULL,
        severity   TEXT NOT NULL,
        message    TEXT NOT NULL,
        value      REAL,
        raised_at  INTEGER NOT NULL,
        cleared_at INTEGER,
        cleared_by TEXT
      );
      CREATE UNIQUE INDEX idx_alerts_open ON alerts(rule_id, metric) WHERE cleared_at IS NULL;
      CREATE INDEX idx_alerts_raised ON alerts(raised_at);
    `);
  },
  // 5: operator settings saved from the Settings page (5b-1: retention).
  // Key/value with JSON values, so later settings need no migration.
  (db) => {
    db.exec(`
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
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
