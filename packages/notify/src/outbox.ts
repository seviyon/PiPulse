import type { PiPulseDb } from '@pipulse/storage';
import { shiftState } from './state.js';

/** Runs `fn` in one write transaction: all its changes land, or none do. Not reentrant. */
export function atomically<T>(db: PiPulseDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export type NotificationEvent = 'raised' | 'cleared';
/** What a row holds: an alert event, or the recovery summary compaction queues. */
export type OutboxEvent = NotificationEvent | 'summary';
export type FailedKind = 'rejected' | 'abandoned';

export interface OutboxRow {
  id: number;
  webhookId: string;
  alertId: number;
  event: OutboxEvent;
  ruleId: string;
  metric: string;
  payload: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  nextAt: number;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
  failedAt: number | null;
  /** Set before every delivery attempt and never cleared: the row may have reached the receiver. */
  startedAt: number | null;
  failedKind: FailedKind | null;
}

const COLUMNS = `id, webhook_id AS webhookId, alert_id AS alertId, event, rule_id AS ruleId,
  metric, payload, status, attempts, next_at AS nextAt, last_error AS lastError,
  created_at AS createdAt, sent_at AS sentAt, failed_at AS failedAt,
  started_at AS startedAt, failed_kind AS failedKind`;

/** Enqueues one notification for one webhook, pending delivery. */
export function insertNotification(
  db: PiPulseDb,
  row: Pick<
    OutboxRow,
    'webhookId' | 'alertId' | 'event' | 'ruleId' | 'metric' | 'payload' | 'nextAt' | 'createdAt'
  >
): void {
  db.prepare(
    `INSERT INTO notifications (webhook_id, alert_id, event, rule_id, metric, payload, next_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.webhookId,
    row.alertId,
    row.event,
    row.ruleId,
    row.metric,
    row.payload,
    row.nextAt,
    row.createdAt
  );
}

/**
 * The webhook's next row: a row that was already started first (it may have been delivered, so
 * it settles before anything else), then a recovery summary (it goes before the backlog),
 * then the rest by id. Later rows wait behind it, so order holds per webhook.
 */
export function headOf(db: PiPulseDb, webhookId: string): OutboxRow | undefined {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM notifications WHERE webhook_id = ? AND status = 'pending' ORDER BY started_at IS NULL, event <> 'summary', id LIMIT 1`
    )
    .get(webhookId) as unknown as OutboxRow | undefined;
}

/** Marks a row delivered. Counts the successful attempt too. */
export function markSent(db: PiPulseDb, id: number, at: number): void {
  db.prepare(
    `UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`
  ).run(at, id);
}

/** Records one failed delivery attempt and when to retry; the row stays pending. */
export function markAttemptFailed(
  db: PiPulseDb,
  id: number,
  at: number,
  reason: string,
  nextAt: number
): void {
  db.prepare(
    `UPDATE notifications
     SET attempts = attempts + 1, last_error = ?, failed_at = ?, next_at = ?
     WHERE id = ?`
  ).run(reason, at, nextAt, id);
}

/** Records that the sender is about to try this row; kept for good (see `startedAt`). */
export function markStarted(db: PiPulseDb, id: number, at: number): void {
  db.prepare(`UPDATE notifications SET started_at = ? WHERE id = ?`).run(at, id);
}

/** Fails a row for good: rejected by a permanent answer, or abandoned once retries ran out. */
export function markFailed(
  db: PiPulseDb,
  id: number,
  at: number,
  reason: string,
  kind: FailedKind
): void {
  db.prepare(
    `UPDATE notifications
     SET status = 'failed', attempts = attempts + 1, last_error = ?, failed_at = ?, failed_kind = ?
     WHERE id = ?`
  ).run(reason, at, kind, id);
}

/** Reschedules a pending row without recording it as a failed attempt. */
export function setNextAt(db: PiPulseDb, id: number, nextAt: number): void {
  db.prepare(`UPDATE notifications SET next_at = ? WHERE id = ?`).run(nextAt, id);
}

/**
 * Drops one alert's pending 'cleared' notifications (superseded by the re-raise
 * that follows an edit), only for the webhooks in `webhookIds`.
 */
export function deletePendingClears(db: PiPulseDb, alertId: number, webhookIds: string[]): number {
  if (webhookIds.length === 0) return 0;
  const placeholders = webhookIds.map(() => '?').join(', ');
  return Number(
    db
      .prepare(
        `DELETE FROM notifications
         WHERE status = 'pending' AND event = 'cleared' AND alert_id = ? AND webhook_id IN (${placeholders})`
      )
      .run(alertId, ...webhookIds).changes
  );
}

/**
 * Moves every pending row's times by `ms`, after the wall clock jumped by that
 * much, so retry schedules and the give-up age follow real elapsed time.
 */
export function shiftPending(db: PiPulseDb, ms: number): number {
  const moved = Number(
    db
      .prepare(
        `UPDATE notifications SET created_at = created_at + ?, next_at = next_at + ?,
           started_at = started_at + ? WHERE status = 'pending'`
      )
      .run(ms, ms, ms).changes
  );
  shiftState(db, ms);
  return moved;
}

/** A row's creation time, as last shifted; undefined once it is gone. */
export function createdAtOf(db: PiPulseDb, id: number): number | undefined {
  const row = db
    .prepare(`SELECT created_at AS createdAt FROM notifications WHERE id = ?`)
    .get(id) as { createdAt: number } | undefined;
  return row?.createdAt;
}

/** Fails pending rows for webhooks no longer configured (not in `keep`). */
export function failRemovedWebhooks(db: PiPulseDb, keep: string[], at: number): number {
  const placeholders = keep.map(() => '?').join(', ');
  const notIn = placeholders ? `webhook_id NOT IN (${placeholders})` : '1';
  return Number(
    db
      .prepare(
        `UPDATE notifications
         SET status = 'failed', last_error = 'webhook removed', failed_at = ?
         WHERE status = 'pending' AND ${notIn}`
      )
      .run(at, ...keep).changes
  );
}

/** Deletes sent/failed rows that finished before `before`. */
export function pruneNotifications(db: PiPulseDb, before: number): number {
  return Number(
    db
      .prepare(
        `DELETE FROM notifications
         WHERE (status = 'sent' AND sent_at < ?) OR (status = 'failed' AND failed_at < ?)`
      )
      .run(before, before).changes
  );
}

/** Delivery status for one webhook: how much is queued, and its most recent success/failure. */
export function webhookStats(
  db: PiPulseDb,
  webhookId: string
): {
  pending: number;
  lastSuccessAt: number | null;
  lastFailure: { at: number; reason: string } | null;
} {
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications WHERE webhook_id = ? AND status = 'pending'`
      )
      .get(webhookId) as { n: number }
  ).n;
  const sent = db
    .prepare(`SELECT MAX(sent_at) AS at FROM notifications WHERE webhook_id = ?`)
    .get(webhookId) as { at: number | null };
  const failure = db
    .prepare(
      `SELECT failed_at AS at, last_error AS reason FROM notifications
       WHERE webhook_id = ? AND failed_at IS NOT NULL
       ORDER BY failed_at DESC, id DESC LIMIT 1`
    )
    .get(webhookId) as { at: number; reason: string } | undefined;
  return { pending, lastSuccessAt: sent.at, lastFailure: failure ?? null };
}
