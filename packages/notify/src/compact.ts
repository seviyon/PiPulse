import type { PiPulseDb } from '@pipulse/storage';
import type { WebhookConfig } from './config.js';
import { atomically } from './outbox.js';
import { getState, markSummary, addCount, takeUnsummarized, type CountKind } from './state.js';
import { renderSummary, type SummaryInput } from './summary.js';
import type { MetricLabel } from './template.js';

/** A row younger than this is never coalesced (a short blip stays lossless), unless over the cap. */
export const ELIGIBLE_AFTER_MS = 5 * 60_000;
/** Above this many pending alert rows, age no longer protects a row from being coalesced. */
export const PENDING_CAP = 100;

const RANK = { warning: 0, critical: 1 } as const;

interface PendingRow {
  id: number;
  alertId: number;
  event: 'raised' | 'cleared';
  ruleId: string;
  startedAt: number | null;
  createdAt: number;
}

interface SummaryDetail {
  since: number;
  counts: { kind: CountKind; ruleId: string; n: number }[];
}

export interface CompactResult {
  /** Rows deleted. */
  coalesced: number;
  summaryQueued: boolean;
}

/**
 * Compacts one webhook's queue in a single transaction: deletes the never-started rows the
 * receiver does not need (an alert that opened and cleared while delivery was down), counts
 * them per rule, and queues, or adds to, one recovery summary. Rows that may have reached
 * the receiver (`started_at` set), raises of alerts still open and the clears that follow a
 * started raise are never touched. A crash leaves the old state or the new one.
 * See the notify queue design, "Compaction".
 */
export function compact(
  db: PiPulseDb,
  webhook: WebhookConfig,
  context: { now: number; hostname: string; metrics: MetricLabel[] }
): CompactResult {
  return atomically(db, () => {
    const { now } = context;
    const rows = db
      .prepare(
        `SELECT id, alert_id AS alertId, event, rule_id AS ruleId, started_at AS startedAt,
           created_at AS createdAt
         FROM notifications
         WHERE webhook_id = ? AND status = 'pending' AND event IN ('raised', 'cleared')
         ORDER BY id`
      )
      .all(webhook.id) as unknown as PendingRow[];
    const over = rows.length > PENDING_CAP;
    const young = (row: PendingRow) => now - row.createdAt < ELIGIBLE_AFTER_MS;
    const getsRaises = webhook.events.includes('raised');

    // An alert is still going when it is open, or when an unchanged rule edit closed it and
    // reopened it as another alert that has no raise of its own here (the enqueuer leaves
    // that raise out on purpose: the first one stands for both).
    const alertGoing = (alertId: number) =>
      db
        .prepare(
          `SELECT 1 FROM alerts a WHERE a.id = ? AND (
             a.cleared_at IS NULL OR (
               a.cleared_by = 'rule_changed' AND EXISTS (
                 SELECT 1 FROM alerts b
                 WHERE b.rule_id = a.rule_id AND b.metric = a.metric
                   AND b.cleared_at IS NULL AND b.raised_at = a.cleared_at
                   AND NOT EXISTS (
                     SELECT 1 FROM notifications n
                     WHERE n.webhook_id = ? AND n.alert_id = b.id AND n.event = 'raised'))))`
        )
        .get(alertId, webhook.id) !== undefined;

    const byAlert = new Map<number, { raise?: PendingRow; clear?: PendingRow }>();
    for (const row of rows) {
      const group = byAlert.get(row.alertId) ?? {};
      if (row.event === 'raised') group.raise = row;
      else group.clear = row;
      byAlert.set(row.alertId, group);
    }

    const doomed: number[] = [];
    const drop = (rule: string, kind: CountKind, ...ids: number[]) => {
      doomed.push(...ids);
      addCount(db, webhook.id, kind, rule);
    };
    for (const [alertId, { raise, clear }] of byAlert) {
      if (raise && raise.startedAt === null) {
        // A never-started raise goes only with an alert that is over and a clear (if any) that
        // was never started either.
        if (alertGoing(alertId) || (clear && clear.startedAt !== null)) continue;
        if (young(raise) && !over) continue;
        const ids = clear ? [raise.id, clear.id] : [raise.id];
        drop(raise.ruleId, young(raise) ? 'dropped' : 'opened_and_cleared', ...ids);
      } else if (!raise && clear && clear.startedAt === null && !getsRaises) {
        // A cleared-only webhook never gets raises: there is no lifecycle to keep.
        if (young(clear) && !over) continue;
        drop(clear.ruleId, young(clear) ? 'dropped' : 'cleared', clear.id);
      }
      // Anything else stays: a started raise keeps its clear, and a clear whose raise was
      // sent, failed after a start or pruned is a clear the receiver must hear.
    }
    if (doomed.length > 0) {
      const marks = doomed.map(() => '?').join(', ');
      db.prepare(`DELETE FROM notifications WHERE id IN (${marks})`).run(...doomed);
    }

    // An endpoint that rejects every request would reject the summary too, and the summary's
    // counts would be spent: keep counting, and report everything once it answers again.
    if (getState(db, webhook.id).needsAttention)
      return { coalesced: doomed.length, summaryQueued: false };

    const counts = takeUnsummarized(db, webhook.id);
    if (counts.length === 0) return { coalesced: doomed.length, summaryQueued: false };

    const existing = db
      .prepare(
        `SELECT id, detail FROM notifications
         WHERE webhook_id = ? AND event = 'summary' AND status = 'pending' AND started_at IS NULL
         ORDER BY id LIMIT 1`
      )
      .get(webhook.id) as { id: number; detail: string | null } | undefined;
    const merged = new Map<string, { kind: CountKind; ruleId: string; n: number }>();
    let since = getState(db, webhook.id).degradedSince ?? now;
    const add = (c: { kind: CountKind; ruleId: string; n: number }) => {
      const key = `${c.kind}\u0000${c.ruleId}`;
      const have = merged.get(key);
      merged.set(key, { ...c, n: (have?.n ?? 0) + c.n });
    };
    if (existing?.detail) {
      const previous = JSON.parse(existing.detail) as SummaryDetail;
      previous.counts.forEach(add);
      since = Math.min(since, previous.since);
    }
    counts.forEach(add);

    const open = (
      db
        .prepare(
          `SELECT rule_id AS ruleId, metric, severity FROM alerts WHERE cleared_at IS NULL ORDER BY id`
        )
        .all() as unknown as SummaryInput['open']
    ).filter((a) => RANK[a.severity] >= RANK[webhook.minSeverity]);
    const input: SummaryInput = { counts: [...merged.values()], open, since, now };
    const payload = renderSummary(webhook, input, context);
    const detail = JSON.stringify({ since, counts: input.counts } satisfies SummaryDetail);
    if (existing) {
      db.prepare(`UPDATE notifications SET payload = ?, detail = ? WHERE id = ?`).run(
        payload,
        detail,
        existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO notifications (webhook_id, alert_id, event, rule_id, metric, payload, next_at, created_at, detail)
         VALUES (?, 0, 'summary', '', '', ?, ?, ?, ?)`
      ).run(webhook.id, payload, now, now, detail);
    }
    markSummary(db, webhook.id, now);
    return { coalesced: doomed.length, summaryQueued: true };
  });
}
