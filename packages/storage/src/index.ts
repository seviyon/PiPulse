import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';
import { retryWhileLocked } from './retry.js';

export { migrate, SCHEMA_VERSION } from './migrations.js';

export type PiPulseDb = DatabaseSync;

/** How long a statement waits for another connection's write lock. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens (and creates, if needed) the PiPulse SQLite database at `path`,
 * enables WAL mode for concurrent collector-writes / API-reads, and
 * ensures the schema exists.
 */
export function openDb(path: string): PiPulseDb {
  const db = new DatabaseSync(path);
  // First, before any statement that needs a lock: a second process opening the file at the same
  // time (the server and the collector) waits its turn instead of failing with "database is locked".
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  retryWhileLocked(() => db.exec('PRAGMA journal_mode = WAL'));
  createSchema(db);
  return db;
}

/** Creates or upgrades the schema; kept for callers that predate migrate(). */
export function createSchema(db: PiPulseDb): void {
  migrate(db);
}

export interface Sample {
  ts: number;
  metric: string;
  value: number;
}

const insertStatementCache = new WeakMap<PiPulseDb, ReturnType<PiPulseDb['prepare']>>();

/** Inserts (or replaces) one raw sample. */
export function insertSample(db: PiPulseDb, sample: Sample): void {
  let stmt = insertStatementCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      'INSERT OR REPLACE INTO metrics (ts, metric, value) VALUES (@ts, @metric, @value)'
    );
    insertStatementCache.set(db, stmt);
  }
  stmt.run({ ts: sample.ts, metric: sample.metric, value: sample.value });
}

/** A reading may be stamped this far ahead of the reader's clock (two processes, two reads of it). */
const LATEST_SLACK_MS = 5 * 60_000;

/**
 * The newest reading of every metric at or before `?`. The primary key is (metric, ts), so a plain
 * `MAX(ts) ... WHERE ts <= ? GROUP BY metric` cannot seek: it reads every raw row, about half a
 * second on a Pi 2 with two days of readings, and the synchronous call stalls the whole process.
 * This walks the distinct metric names with one seek each (a loose index scan) and then seeks the
 * newest allowed reading of each: a few dozen index lookups however many rows there are.
 * Exported only so a test can check its query plan.
 */
export const LATEST_SQL = `WITH RECURSIVE names(metric) AS (
  SELECT MIN(metric) FROM metrics
  UNION ALL
  SELECT (SELECT MIN(metric) FROM metrics WHERE metric > names.metric)
  FROM names WHERE names.metric IS NOT NULL
)
SELECT m.ts AS ts, m.metric AS metric, m.value AS value
FROM names n
JOIN metrics m ON m.metric = n.metric
 AND m.ts = (SELECT MAX(ts) FROM metrics WHERE metric = n.metric AND ts <= ?)
WHERE n.metric IS NOT NULL`;

/**
 * Returns the most recent value recorded for every distinct metric. With `now`, a reading stamped
 * after it (plus a few minutes) is not "most recent": it was written by a clock that read ahead
 * and came back, and would otherwise be served for as long as the clock was off.
 */
export function getLatest(db: PiPulseDb, now?: number): Sample[] {
  const limit = now === undefined ? Number.MAX_SAFE_INTEGER : now + LATEST_SLACK_MS;
  return db.prepare(LATEST_SQL).all(limit) as unknown as Sample[];
}

/**
 * The most raw readings one request may ask for. The dashboard never needs more than 1500 (`auto`
 * stops there). The read is synchronous, so the process does nothing else while it builds the
 * answer. Measured on a Pi 2 from a LAN client, a raw answer costs about 75 ms per 1000 readings
 * end to end (query, JSON and transfer together; the process's own share is part of that), so 5000
 * keeps the worst case near half a second. Longer windows have the rolled-up resolutions.
 */
export const MAX_RAW_ROWS = 5000;

/**
 * Whether `metric` has more than `max` raw readings in [from, to]. The inner LIMIT stops the
 * primary-key scan at `max + 1`, so this costs at most that many index steps however large the
 * table is.
 */
export function rawRowsExceed(
  db: PiPulseDb,
  metric: string,
  from: number,
  to: number,
  max = MAX_RAW_ROWS
): boolean {
  const { n } = db
    .prepare(
      'SELECT COUNT(*) AS n FROM (SELECT 1 FROM metrics WHERE metric = ? AND ts BETWEEN ? AND ? LIMIT ?)'
    )
    .get(metric, from, to, max + 1) as { n: number };
  return n > max;
}

/** Returns raw samples for one metric within an inclusive [from, to] window (unix ms). */
export function getHistory(db: PiPulseDb, metric: string, from: number, to: number): Sample[] {
  return db
    .prepare(
      'SELECT ts, metric, value FROM metrics WHERE metric = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC'
    )
    .all(metric, from, to) as unknown as Sample[];
}

export {
  chooseResolution,
  DEFAULT_RETENTION,
  getSeries,
  MAX_SERIES_ROWS,
  parseDuration,
  retentionFromEnv,
  runHousekeeping,
  seriesRowsExceed,
  startHousekeeping,
  type HousekeepingOptions,
  type HousekeepingResult,
  type Resolution,
  type RetentionPolicy,
  type SeriesPoint
} from './rollup.js';

export { getSettings, saveSettings } from './settings.js';

export {
  DEFAULT_RETENTION_TEXT,
  policyOf,
  RESOLUTION_LABELS,
  RESOLUTIONS,
  resolveRetention,
  RETENTION_VARIABLES,
  retentionSource,
  saveRetention,
  validateRetention,
  type LookBack,
  type RetentionCheck,
  type RetentionLevel,
  type RetentionSettings
} from './retention.js';

export {
  databaseFile,
  diskFreeBytes,
  fileUsage,
  maybeVacuum,
  type VacuumOptions,
  type VacuumResult
} from './vacuum.js';

export {
  estimateBytes,
  previewDeletion,
  storageUsage,
  type LevelDeletion,
  type LevelUsage,
  type StorageUsage
} from './usage.js';
