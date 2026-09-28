import type { PiPulseDb } from '@pipulse/storage';
import type { AlertEvent } from '@pipulse/alerts';
import { createWebhookAction, type AlertAction } from './action.js';
import { urlHost, type WebhookConfig } from './config.js';
import { createEnqueuer } from './enqueue.js';
import {
  failRemovedWebhooks,
  headOf,
  markAttemptFailed,
  markGivenUp,
  markSent,
  pruneNotifications,
  setNextAt,
  webhookStats
} from './outbox.js';
import type { MetricLabel } from './template.js';

export const FIRST_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 5 * 60_000;
export const GIVE_UP_AFTER_MS = 6 * 60 * 60_000;
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;

/** Delay before the next try, given the attempts already made: 1 → 5 s, 2 → 10 s, … capped at 5 min. */
export function retryDelay(attempts: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

/** Delivers at most one due row per webhook, in parallel across webhooks; resolves to how many were sent. */
export async function sendDue(
  db: PiPulseDb,
  actions: { action: AlertAction; timeoutMs: number }[],
  options: {
    now: () => number;
    onGiveUp?: (webhookId: string, attempts: number, reason: string) => void;
  }
): Promise<number> {
  const results = await Promise.all(
    actions.map(async ({ action, timeoutMs }) => {
      const row = headOf(db, action.id);
      if (!row) return 0;
      const t = options.now();
      // The Pi has no RTC: after the clock jumps back, a retry could sit hours
      // away. Never wait longer than the longest retry delay.
      if (row.nextAt - t > MAX_RETRY_MS) {
        setNextAt(db, row.id, t + MAX_RETRY_MS);
        return 0;
      }
      if (row.nextAt > t) return 0;
      try {
        await action.deliver(row.payload, AbortSignal.timeout(timeoutMs));
        markSent(db, row.id, options.now());
        return 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const at = options.now();
        if (at - row.createdAt >= GIVE_UP_AFTER_MS) {
          markGivenUp(db, row.id, at, reason);
          options.onGiveUp?.(action.id, row.attempts + 1, reason);
        } else {
          markAttemptFailed(db, row.id, at, reason, at + retryDelay(row.attempts + 1));
        }
        return 0;
      }
    })
  );
  return results.reduce<number>((a, b) => a + b, 0);
}

export interface WebhookStatus {
  id: string;
  host: string;
  method: 'POST' | 'PUT';
  events: ('raised' | 'cleared')[];
  minSeverity: 'warning' | 'critical';
  pending: number;
  lastSuccessAt: number | null;
  lastFailure: { at: number; reason: string } | null;
}

export interface Notifications {
  enqueue(event: AlertEvent): void;
  status(): WebhookStatus[];
  stop(): Promise<void>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Starts delivering queued notifications: wakes on every enqueue and every
 * `intervalMs` (for retries), never throws, and logs what it gives up on.
 */
export function startNotifications(
  db: PiPulseDb,
  options: {
    webhooks: WebhookConfig[];
    hostname: string;
    metrics: MetricLabel[];
    log?: (message: string) => void;
    now?: () => number;
    intervalMs?: number;
    actions?: AlertAction[];
  }
): Notifications {
  const { webhooks } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(`[pipulse] ${message}`));
  const actions = webhooks.map((webhook) => ({
    action: options.actions?.find((a) => a.id === webhook.id) ?? createWebhookAction(webhook),
    timeoutMs: webhook.timeoutMs
  }));

  failRemovedWebhooks(
    db,
    webhooks.map((w) => w.id),
    now()
  );

  let lastPrune: number | undefined;
  const maybePrune = () => {
    const t = now();
    // abs(): after the clock jumps back, prune again within the hour rather than waiting for it to catch up.
    if (lastPrune !== undefined && Math.abs(t - lastPrune) < PRUNE_EVERY_MS) return;
    lastPrune = t;
    try {
      pruneNotifications(db, t - PRUNE_AFTER_MS);
    } catch (error) {
      log(`notification pruning failed: ${messageOf(error)}`);
    }
  };

  const status = (): WebhookStatus[] =>
    webhooks.map((w) => ({
      id: w.id,
      host: urlHost(w.url),
      method: w.method,
      events: w.events,
      minSeverity: w.minSeverity,
      ...webhookStats(db, w.id)
    }));

  if (webhooks.length === 0) {
    // Nothing to deliver, but rows from webhooks removed since the last run still age out.
    maybePrune();
    return { enqueue: () => {}, status, stop: async () => {} };
  }

  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const drain = async () => {
    while (!stopped) {
      again = false;
      maybePrune();
      let sent = 0;
      try {
        sent = await sendDue(db, actions, {
          now,
          onGiveUp: (id, n, reason) =>
            log(`webhook ${id}: gave up after ${n} attempts (last: ${reason})`)
        });
      } catch (error) {
        log(`notification delivery failed: ${messageOf(error)}`);
      }
      if (sent === 0 && !again) return;
    }
  };

  const wake = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = drain().finally(() => {
      running = undefined;
    });
  };

  const enqueue = createEnqueuer(db, {
    webhooks,
    hostname: options.hostname,
    metrics: options.metrics,
    now,
    onQueued: wake,
    onError: (error) => log(`notification queueing failed: ${messageOf(error)}`)
  });

  const timer = setInterval(wake, options.intervalMs ?? 5000);
  timer.unref?.();
  wake();

  return {
    enqueue,
    status,
    async stop() {
      clearInterval(timer);
      stopped = true;
      await running;
    }
  };
}
