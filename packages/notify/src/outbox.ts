import type { PiPulseDb } from '@pipulse/storage';

export type NotificationEvent = 'raised' | 'cleared';

export interface OutboxRow {
  id: number;
  webhookId: string;
  alertId: number;
  event: NotificationEvent;
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
}

const COLUMNS = `id, webhook_id AS webhookId, alert_id AS alertId, event, rule_id AS ruleId,
  metric, payload, status, attempts, next_at AS nextAt, last_error AS lastError,
  created_at AS createdAt, sent_at AS sentAt, failed_at AS failedAt`;

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

/** The webhook's oldest pending row: later rows wait behind it, so order holds per webhook. */
export function headOf(db: PiPulseDb, webhookId: string): OutboxRow | undefined {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM notifications WHERE webhook_id = ? AND status = 'pending' ORDER BY id LIMIT 1`
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

/** Gives up on a row after retries are exhausted. */
export function markGivenUp(db: PiPulseDb, id: number, at: number, reason: string): void {
  db.prepare(
    `UPDATE notifications
     SET status = 'failed', attempts = attempts + 1, last_error = ?, failed_at = ?
     WHERE id = ?`
  ).run(reason, at, id);
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
