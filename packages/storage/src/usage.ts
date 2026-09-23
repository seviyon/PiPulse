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

/** Rows and the oldest row of one level, optionally only those in [since, before). */
function levelQuery(
  db: DatabaseSync,
  resolution: Resolution,
  range: { since?: number; before?: number } = {}
): LevelUsage {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (resolution !== 'raw') {
    where.push('resolution = ?');
    params.push(resolution);
  }
  if (range.since !== undefined) {
    where.push('ts >= ?');
    params.push(range.since);
  }
  if (range.before !== undefined) {
    where.push('ts < ?');
    params.push(range.before);
  }
  const table = resolution === 'raw' ? 'metrics' : 'metrics_rollup';
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM ${table}` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
    )
    .get(...params) as { rows: number; oldest: number | null };
  return { rows: Number(row.rows), oldest: row.oldest };
}

/** File size, free pages, and rows and oldest row per level. */
export function storageUsage(db: DatabaseSync): StorageUsage {
  const levels = {} as Record<Resolution, LevelUsage>;
  for (const resolution of RESOLUTIONS) levels[resolution] = levelQuery(db, resolution);
  return { ...fileUsage(db), levels };
}

/**
 * What changing from `current` to `proposed` deletes: per level whose
 * retention gets shorter, the rows between the new cutoff and the current
 * one. Rows already past the current cutoff (housekeeping runs once a
 * minute) were going anyway and don't count.
 */
export function previewDeletion(
  db: DatabaseSync,
  proposed: RetentionPolicy,
  current: RetentionPolicy,
  now: number
): Record<Resolution, LevelDeletion> {
  const preview = {} as Record<Resolution, LevelDeletion>;
  for (const resolution of RESOLUTIONS) {
    const ms = proposed[resolution];
    const currentMs = current[resolution];
    if (!(ms < currentMs)) {
      preview[resolution] = { deletesRows: 0, from: null, to: null };
      continue;
    }
    const cutoff = now - ms;
    const doomed = levelQuery(db, resolution, {
      ...(Number.isFinite(currentMs) ? { since: now - currentMs } : {}),
      before: cutoff
    });
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
