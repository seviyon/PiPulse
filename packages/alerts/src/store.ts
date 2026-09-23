import type { PiPulseDb } from '@pipulse/storage';
import type { Reading, WindowSummary } from './evaluate.js';
import type { Severity } from './rules.js';

export interface Alert {
  id: number;
  ruleId: string;
  metric: string;
  severity: Severity;
  message: string;
  /** The reading that raised it; null for a silence alert. */
  value: number | null;
  raisedAt: number;
  clearedAt: number | null;
  clearedBy: 'condition' | 'rule_removed' | null;
}

const COLUMNS = `id, rule_id AS ruleId, metric, severity, message, value,
  raised_at AS raisedAt, cleared_at AS clearedAt, cleared_by AS clearedBy`;

/** Parameters: mask, metric, from, to. Exported so a test can check its query plan. */
export const WINDOW_SQL = `SELECT COUNT(*) AS count, MIN(ts) AS oldest, MAX(ts) AS newest,
    MIN(value) AS min, MAX(value) AS max,
    COALESCE(SUM((CAST(value AS INTEGER) & ?) != 0), 0) AS withBits,
    MAX(gap) AS maxGap
  FROM (SELECT ts, value, ts - LAG(ts) OVER (ORDER BY ts) AS gap
    FROM metrics WHERE metric = ? AND ts BETWEEN ? AND ?)`;

/** One metric's raw readings in [from, to], via the (metric, ts) primary key. */
export function summarizeWindow(
  db: PiPulseDb,
  metric: string,
  from: number,
  to: number,
  mask = 0
): WindowSummary {
  return db.prepare(WINDOW_SQL).get(mask, metric, from, to) as unknown as WindowSummary;
}

export function latestReading(db: PiPulseDb, metric: string): Reading | null {
  const row = db
    .prepare('SELECT ts, value FROM metrics WHERE metric = ? ORDER BY ts DESC LIMIT 1')
    .get(metric) as Reading | undefined;
  return row ?? null;
}

/**
 * The start of the metric's newest rollup bucket (its average as the value),
 * for when housekeeping has pruned every raw reading. Finer levels are newer,
 * so the first level that has a row wins. Being a bucket start, it can be up
 * to one bucket earlier than the reading itself.
 */
export function latestRollup(db: PiPulseDb, metric: string): Reading | null {
  const newest = (resolution: string) =>
    `SELECT ts, avg AS value FROM metrics_rollup WHERE metric = ?1 AND resolution = '${resolution}' ORDER BY ts DESC LIMIT 1`;
  const row = db
    .prepare(
      `SELECT ts, value FROM (${newest('1m')}) UNION ALL SELECT ts, value FROM (${newest('1h')})
       UNION ALL SELECT ts, value FROM (${newest('1d')}) LIMIT 1`
    )
    .get(metric) as Reading | undefined;
  return row ?? null;
}

export function openAlerts(db: PiPulseDb): Alert[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM alerts WHERE cleared_at IS NULL ORDER BY raised_at DESC, id DESC`
    )
    .all() as unknown as Alert[];
}

/**
 * Newest first. 'active': every open alert; 'cleared': cleared ones raised in
 * [from, to]; 'all': both.
 */
export function listAlerts(
  db: PiPulseDb,
  query: { state: 'active' | 'cleared' | 'all'; from: number; to: number; limit: number }
): Alert[] {
  const where = {
    active: 'cleared_at IS NULL',
    cleared: 'cleared_at IS NOT NULL AND raised_at BETWEEN ? AND ?',
    all: '(cleared_at IS NULL OR raised_at BETWEEN ? AND ?)'
  }[query.state];
  const params = query.state === 'active' ? [query.limit] : [query.from, query.to, query.limit];
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM alerts WHERE ${where} ORDER BY raised_at DESC, id DESC LIMIT ?`
    )
    .all(...params) as unknown as Alert[];
}

export function raiseAlert(
  db: PiPulseDb,
  alert: Omit<Alert, 'id' | 'clearedAt' | 'clearedBy'>
): Alert {
  return db
    .prepare(
      `INSERT INTO alerts (rule_id, metric, severity, message, value, raised_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`
    )
    .get(
      alert.ruleId,
      alert.metric,
      alert.severity,
      alert.message,
      alert.value,
      alert.raisedAt
    ) as unknown as Alert;
}

export function clearAlert(
  db: PiPulseDb,
  id: number,
  clearedAt: number,
  clearedBy: 'condition' | 'rule_removed'
): Alert {
  return db
    .prepare(`UPDATE alerts SET cleared_at = ?, cleared_by = ? WHERE id = ? RETURNING ${COLUMNS}`)
    .get(clearedAt, clearedBy, id) as unknown as Alert;
}
