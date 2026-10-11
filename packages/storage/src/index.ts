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
 * Returns the most recent value recorded for every distinct metric. With `now`, a reading stamped
 * after it (plus a few minutes) is not "most recent": it was written by a clock that read ahead
 * and came back, and would otherwise be served for as long as the clock was off.
 */
export function getLatest(db: PiPulseDb, now?: number): Sample[] {
  const limit = now === undefined ? Number.MAX_SAFE_INTEGER : now + LATEST_SLACK_MS;
  return db
    .prepare(
      `SELECT m.ts as ts, m.metric as metric, m.value as value
       FROM metrics m
       JOIN (
         SELECT metric, MAX(ts) as ts FROM metrics WHERE ts <= ? GROUP BY metric
       ) latest ON latest.metric = m.metric AND latest.ts = m.ts`
    )
    .all(limit) as unknown as Sample[];
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
  parseDuration,
  retentionFromEnv,
  runHousekeeping,
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
