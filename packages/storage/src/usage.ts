import type { DatabaseSync } from 'node:sqlite';
import { RESOLUTIONS } from './retention.js';
import type { Resolution, RetentionPolicy } from './rollup.js';
import { fileUsage } from './vacuum.js';

const DAY = 86_400_000;
/** Bytes per row assumed until the database holds enough rows to measure. */
const FALLBACK_BYTES_PER_ROW = 50;

export interface LevelUsage {
  rows: number;
  oldest: number | null;
}

export interface StorageUsage {
  fileBytes: number;
  freeBytes: number;
  levels: Record<Resolution, LevelUsage>;
}

export interface LevelDeletion {
  deletesRows: number;
  /** Oldest row that would go, or null when nothing would. */
  from: number | null;
  /** The new cutoff, or null when nothing would go. */
  to: number | null;
}

function levelQuery(db: DatabaseSync, resolution: Resolution, before?: number): LevelUsage {
  const row = (
    resolution === 'raw'
      ? before === undefined
        ? db.prepare('SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM metrics').get()
        : db
            .prepare('SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM metrics WHERE ts < ?')
            .get(before)
      : before === undefined
        ? db
            .prepare(
              'SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM metrics_rollup WHERE resolution = ?'
            )
            .get(resolution)
        : db
            .prepare(
              'SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM metrics_rollup WHERE resolution = ? AND ts < ?'
            )
            .get(resolution, before)
  ) as { rows: number; oldest: number | null };
  return { rows: Number(row.rows), oldest: row.oldest };
}

/** File size, free pages, and rows and oldest row per level. */
export function storageUsage(db: DatabaseSync): StorageUsage {
  const levels = {} as Record<Resolution, LevelUsage>;
  for (const resolution of RESOLUTIONS) levels[resolution] = levelQuery(db, resolution);
  return { ...fileUsage(db), levels };
}

/**
 * What housekeeping would delete under `policy`: rows older than each
 * level's cutoff. An upper bound — raw rows not yet rolled up wait a
 * minute longer.
 */
export function previewDeletion(
  db: DatabaseSync,
  policy: RetentionPolicy,
  now: number
): Record<Resolution, LevelDeletion> {
  const preview = {} as Record<Resolution, LevelDeletion>;
  for (const resolution of RESOLUTIONS) {
    const ms = policy[resolution];
    if (!Number.isFinite(ms)) {
      preview[resolution] = { deletesRows: 0, from: null, to: null };
      continue;
    }
    const cutoff = now - ms;
    const doomed = levelQuery(db, resolution, cutoff);
    preview[resolution] =
      doomed.rows === 0
        ? { deletesRows: 0, from: null, to: null }
        : { deletesRows: doomed.rows, from: doomed.oldest, to: cutoff };
  }
  return preview;
}

/**
 * The database size once `policy` is full. Rows per day come from what is
 * collected (raw from each plugin's interval; each rollup level one row per
 * metric per bucket); bytes per row are measured from the database itself.
 * A level kept forever is estimated for one year.
 */
export function estimateBytes(
  policy: RetentionPolicy,
  metrics: { intervalMs: number }[],
  usage: StorageUsage
): number {
  const perDay: Record<Resolution, number> = {
    raw: metrics.reduce((sum, metric) => sum + DAY / metric.intervalMs, 0),
    '1m': metrics.length * 1440,
    '1h': metrics.length * 24,
    '1d': metrics.length
  };
  const rowsNow = RESOLUTIONS.reduce((sum, r) => sum + usage.levels[r].rows, 0);
  const bytesPerRow =
    rowsNow >= 1000 ? (usage.fileBytes - usage.freeBytes) / rowsNow : FALLBACK_BYTES_PER_ROW;
  const rows = RESOLUTIONS.reduce((sum, r) => {
    const days = Number.isFinite(policy[r]) ? policy[r] / DAY : 365;
    return sum + perDay[r] * days;
  }, 0);
  return Math.round(rows * bytesPerRow);
}
