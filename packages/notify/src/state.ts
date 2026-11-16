import type { PiPulseDb } from '@pipulse/storage';

/** What compaction and failures count, per webhook and per rule (see the notify queue design). */
export type CountKind = 'opened_and_cleared' | 'cleared' | 'rejected' | 'abandoned' | 'dropped';

export interface WebhookState {
  webhookId: string;
  /** First failed attempt, until a delivery succeeds and the queue is empty. Drives compaction. */
  degradedSince: number | null;
  /** Set by a permanent rejection, cleared by a non-permanent HTTP answer. Drives pacing. */
  needsAttention: boolean;
  reason: string | null;
  nextProbeAt: number | null;
  /** Lifetime totals; never used to build text. */
  counts: Record<CountKind, number>;
  lastSummaryAt: number | null;
}

interface StateRow {
  degradedSince: number | null;
  needsAttention: number;
  reason: string | null;
  nextProbeAt: number | null;
  opened_and_cleared: number;
  cleared: number;
  rejected: number;
  abandoned: number;
  dropped: number;
  lastSummaryAt: number | null;
}

const COUNT_KINDS: readonly CountKind[] = [
  'opened_and_cleared',
  'cleared',
  'rejected',
  'abandoned',
  'dropped'
];

export function getState(db: PiPulseDb, webhookId: string): WebhookState {
  const row = db
    .prepare(
      `SELECT degraded_since AS degradedSince, needs_attention AS needsAttention, reason,
         next_probe_at AS nextProbeAt, opened_and_cleared, cleared, rejected, abandoned, dropped,
         last_summary_at AS lastSummaryAt
       FROM webhook_state WHERE webhook_id = ?`
    )
    .get(webhookId) as unknown as StateRow | undefined;
  return {
    webhookId,
    degradedSince: row?.degradedSince ?? null,
    needsAttention: (row?.needsAttention ?? 0) !== 0,
    reason: row?.reason ?? null,
    nextProbeAt: row?.nextProbeAt ?? null,
    counts: {
      opened_and_cleared: row?.opened_and_cleared ?? 0,
      cleared: row?.cleared ?? 0,
      rejected: row?.rejected ?? 0,
      abandoned: row?.abandoned ?? 0,
      dropped: row?.dropped ?? 0
    },
    lastSummaryAt: row?.lastSummaryAt ?? null
  };
}

const ensure = (db: PiPulseDb, webhookId: string) =>
  db.prepare(`INSERT OR IGNORE INTO webhook_state (webhook_id) VALUES (?)`).run(webhookId);

/** Marks the webhook degraded from `at`; keeps the earlier time if it already is. */
export function setDegraded(db: PiPulseDb, webhookId: string, at: number): void {
  ensure(db, webhookId);
  db.prepare(
    `UPDATE webhook_state SET degraded_since = ? WHERE webhook_id = ? AND degraded_since IS NULL`
  ).run(at, webhookId);
}

/**
 * Ends the degraded period, but only when nothing is left to deliver and nothing is left to
 * report: counts not yet in a summary keep it open, so the next compaction makes that summary.
 */
export function clearDegradedIfIdle(db: PiPulseDb, webhookId: string): void {
  db.prepare(
    `UPDATE webhook_state SET degraded_since = NULL
     WHERE webhook_id = ?
       AND NOT EXISTS (SELECT 1 FROM notifications WHERE webhook_id = ? AND status = 'pending')
       AND NOT EXISTS (SELECT 1 FROM webhook_summary_counts WHERE webhook_id = ?)`
  ).run(webhookId, webhookId, webhookId);
}

export function setNeedsAttention(
  db: PiPulseDb,
  webhookId: string,
  reason: string,
  nextProbeAt: number
): void {
  ensure(db, webhookId);
  db.prepare(
    `UPDATE webhook_state SET needs_attention = 1, reason = ?, next_probe_at = ? WHERE webhook_id = ?`
  ).run(reason, nextProbeAt, webhookId);
}

export function clearNeedsAttention(db: PiPulseDb, webhookId: string): void {
  db.prepare(
    `UPDATE webhook_state SET needs_attention = 0, reason = NULL, next_probe_at = NULL WHERE webhook_id = ?`
  ).run(webhookId);
}

export function setNextProbeAt(db: PiPulseDb, webhookId: string, at: number): void {
  ensure(db, webhookId);
  db.prepare(`UPDATE webhook_state SET next_probe_at = ? WHERE webhook_id = ?`).run(at, webhookId);
}

/**
 * Counts `n` rows of `kind` for a rule: into the lifetime total and into the per-rule count
 * the next summary will report. Callers run it in the same transaction as the row change.
 */
export function addCount(
  db: PiPulseDb,
  webhookId: string,
  kind: CountKind,
  ruleId: string,
  n = 1
): void {
  if (!COUNT_KINDS.includes(kind)) throw new Error(`unknown count kind ${kind}`);
  ensure(db, webhookId);
  db.prepare(`UPDATE webhook_state SET ${kind} = ${kind} + ? WHERE webhook_id = ?`).run(
    n,
    webhookId
  );
  db.prepare(
    `INSERT INTO webhook_summary_counts (webhook_id, kind, rule_id, n) VALUES (?, ?, ?, ?)
     ON CONFLICT (webhook_id, kind, rule_id) DO UPDATE SET n = n + excluded.n`
  ).run(webhookId, kind, ruleId, n);
}

export function hasUnsummarized(db: PiPulseDb, webhookId: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM webhook_summary_counts WHERE webhook_id = ? LIMIT 1`)
      .get(webhookId) !== undefined
  );
}

/** The per-rule counts not yet reported, left where they are. */
export function peekUnsummarized(
  db: PiPulseDb,
  webhookId: string
): { kind: CountKind; ruleId: string; n: number }[] {
  return db
    .prepare(
      `SELECT kind, rule_id AS ruleId, n FROM webhook_summary_counts WHERE webhook_id = ? ORDER BY kind, rule_id`
    )
    .all(webhookId) as unknown as { kind: CountKind; ruleId: string; n: number }[];
}

/** Reads and removes the per-rule counts not yet reported (call inside the summary's transaction). */
export function takeUnsummarized(
  db: PiPulseDb,
  webhookId: string
): { kind: CountKind; ruleId: string; n: number }[] {
  const rows = peekUnsummarized(db, webhookId);
  db.prepare(`DELETE FROM webhook_summary_counts WHERE webhook_id = ?`).run(webhookId);
  return rows;
}

export function markSummary(db: PiPulseDb, webhookId: string, at: number): void {
  ensure(db, webhookId);
  db.prepare(`UPDATE webhook_state SET last_summary_at = ? WHERE webhook_id = ?`).run(
    at,
    webhookId
  );
}

/** Forgets webhooks no longer configured: their state and unreported counts. */
export function deleteStateExcept(db: PiPulseDb, keep: string[]): void {
  const placeholders = keep.map(() => '?').join(', ');
  const notIn = placeholders ? `webhook_id NOT IN (${placeholders})` : '1';
  db.prepare(`DELETE FROM webhook_state WHERE ${notIn}`).run(...keep);
  db.prepare(`DELETE FROM webhook_summary_counts WHERE ${notIn}`).run(...keep);
}

/** Moves the state's times with a wall-clock jump, like shiftPending does for rows. */
export function shiftState(db: PiPulseDb, ms: number): void {
  db.prepare(
    `UPDATE webhook_state SET degraded_since = degraded_since + ?, next_probe_at = next_probe_at + ?,
       last_summary_at = last_summary_at + ?`
  ).run(ms, ms, ms);
}
