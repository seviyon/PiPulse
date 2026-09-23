import type { PiPulseDb } from '@pipulse/storage';
import type { Reading, WindowSummary } from './evaluate.js';
import type { Severity } from './rules.js';

export type ClearedBy = 'condition' | 'rule_removed' | 'rule_changed';

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
  clearedBy: ClearedBy | null;
  /** When someone marked it as seen; null until then. Cleared with the alert. */
  acknowledgedAt: number | null;
  /** Fingerprint of the rule that raised it (see ruleHash); null before migration 6. */
  ruleHash: string | null;
}

export type NewAlert = Pick<
  Alert,
  'ruleId' | 'metric' | 'severity' | 'message' | 'value' | 'raisedAt'
> & { ruleHash?: string | null };

const COLUMNS = `id, rule_id AS ruleId, metric, severity, message, value,
  raised_at AS raisedAt, cleared_at AS clearedAt, cleared_by AS clearedBy,
  acknowledged_at AS acknowledgedAt, rule_hash AS ruleHash`;

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
 * 'active': every open alert, newest raised first. 'cleared': alerts cleared
 * in [from, to], newest cleared first. 'all': every alert active at some point
 * in [from, to] (open ones however old), newest raised first.
 */
export function listAlerts(
  db: PiPulseDb,
  query: { state: 'active' | 'cleared' | 'all'; from: number; to: number; limit: number }
): Alert[] {
  // Parameters: ?1 from, ?2 to, ?3 limit.
  const [where, order] = {
    active: ['cleared_at IS NULL', 'raised_at'],
    cleared: ['cleared_at BETWEEN ?1 AND ?2', 'cleared_at'],
    all: ['(cleared_at IS NULL OR (raised_at <= ?2 AND cleared_at >= ?1))', 'raised_at']
  }[query.state];
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM alerts WHERE ${where} ORDER BY ${order} DESC, id DESC LIMIT ?3`
    )
    .all(query.from, query.to, query.limit) as unknown as Alert[];
}

export function raiseAlert(db: PiPulseDb, alert: NewAlert): Alert {
  return db
    .prepare(
      `INSERT INTO alerts (rule_id, metric, severity, message, value, raised_at, rule_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`
    )
    .get(
      alert.ruleId,
      alert.metric,
      alert.severity,
      alert.message,
      alert.value,
      alert.raisedAt,
      alert.ruleHash ?? null
    ) as unknown as Alert;
}

export function clearAlert(
  db: PiPulseDb,
  id: number,
  clearedAt: number,
  clearedBy: ClearedBy
): Alert {
  return db
    .prepare(`UPDATE alerts SET cleared_at = ?, cleared_by = ? WHERE id = ? RETURNING ${COLUMNS}`)
    .get(clearedAt, clearedBy, id) as unknown as Alert;
}

/**
 * Marks an open alert as seen. Acknowledging again keeps the first time; a
 * cleared alert can't be acknowledged (the next raise is a new row anyway).
 */
export function acknowledgeAlert(
  db: PiPulseDb,
  id: number,
  at: number
): Alert | 'not_found' | 'cleared' {
  const updated = db
    .prepare(
      `UPDATE alerts SET acknowledged_at = COALESCE(acknowledged_at, ?)
       WHERE id = ? AND cleared_at IS NULL RETURNING ${COLUMNS}`
    )
    .get(at, id) as unknown as Alert | undefined;
  if (updated) return updated;
  return db.prepare('SELECT 1 FROM alerts WHERE id = ?').get(id) ? 'cleared' : 'not_found';
}
