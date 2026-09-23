import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';

export { migrate, SCHEMA_VERSION } from './migrations.js';

export type PiPulseDb = DatabaseSync;

/**
 * Opens (and creates, if needed) the PiPulse SQLite database at `path`,
 * enables WAL mode for concurrent collector-writes / API-reads, and
 * ensures the schema exists.
 */
export function openDb(path: string): PiPulseDb {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
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

/** Returns the most recent value recorded for every distinct metric. */
export function getLatest(db: PiPulseDb): Sample[] {
  return db
    .prepare(
      `SELECT m.ts as ts, m.metric as metric, m.value as value
       FROM metrics m
       JOIN (
         SELECT metric, MAX(ts) as ts FROM metrics GROUP BY metric
       ) latest ON latest.metric = m.metric AND latest.ts = m.ts`
    )
    .all() as unknown as Sample[];
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
