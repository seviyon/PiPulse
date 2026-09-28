import type { PiPulseDb } from '@pipulse/storage';
import type { Alert, AlertEvent } from '@pipulse/alerts';
import type { WebhookConfig } from './config.js';
import { deletePendingClears, insertNotification, type NotificationEvent } from './outbox.js';
import { renderPayload, type MetricLabel } from './template.js';

/** How long a rule_changed clear waits for its reopen before it is sent as a real clear. */
export const CHANGED_CLEAR_DELAY_MS = 30_000;

const RANK = { warning: 0, critical: 1 } as const;

/**
 * Turns engine events into outbox rows, synchronously, right after the engine
 * wrote the alert row. Never throws into the engine: problems go to onError.
 */
export function createEnqueuer(
  db: PiPulseDb,
  options: {
    webhooks: WebhookConfig[];
    hostname: string;
    metrics: MetricLabel[];
    now?: () => number;
    onQueued?: () => void;
    onError?: (error: unknown) => void;
  }
): (event: AlertEvent) => void {
  const now = options.now ?? Date.now;
  const context = { hostname: options.hostname, metrics: options.metrics };

  const queue = (event: NotificationEvent, alert: Alert, nextAt: number) => {
    let queued = false;
    for (const webhook of options.webhooks) {
      if (!webhook.events.includes(event)) continue;
      if (RANK[alert.severity] < RANK[webhook.minSeverity]) continue;
      insertNotification(db, {
        webhookId: webhook.id,
        alertId: alert.id,
        event,
        ruleId: alert.ruleId,
        metric: alert.metric,
        payload: renderPayload(webhook.body, event, alert, context),
        nextAt,
        createdAt: now()
      });
      queued = true;
    }
    if (queued) options.onQueued?.();
  };

  /** The alert an edit closed at the moment this one opened, if any. */
  const closedByEdit = (alert: Alert) =>
    db
      .prepare(
        `SELECT id, severity, message FROM alerts WHERE rule_id = ? AND metric = ? AND cleared_by = 'rule_changed' AND cleared_at = ? ORDER BY id DESC LIMIT 1`
      )
      .get(alert.ruleId, alert.metric, alert.raisedAt) as
      { id: number; severity: string; message: string } | undefined;

  return (event) => {
    if (options.webhooks.length === 0) return;
    try {
      const { alert } = event;
      if (event.type === 'cleared') {
        if (alert.clearedBy === 'rule_removed') return;
        const delayed = alert.clearedBy === 'rule_changed';
        queue('cleared', alert, now() + (delayed ? CHANGED_CLEAR_DELAY_MS : 0));
        return;
      }
      const previous = closedByEdit(alert);
      if (previous) {
        // Only where the reopened alert still reaches: a webhook below its new
        // severity gets the clear, since for it the alert is over.
        const reached = options.webhooks
          .filter((webhook) => RANK[alert.severity] >= RANK[webhook.minSeverity])
          .map((webhook) => webhook.id);
        deletePendingClears(db, previous.id, reached);
        if (previous.severity === alert.severity && previous.message === alert.message) return;
      }
      queue('raised', alert, now());
    } catch (error) {
      options.onError?.(error);
    }
  };
}
