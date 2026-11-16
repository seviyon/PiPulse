import type { PiPulseDb } from '@pipulse/storage';
import type { AlertEvent } from '@pipulse/alerts';
import {
  createWebhookAction,
  DeliveryError,
  MAX_RETRY_AFTER_MS,
  type AlertAction
} from './action.js';
import { urlHost, type WebhookConfig } from './config.js';
import { compact, PENDING_CAP } from './compact.js';
import { createEnqueuer } from './enqueue.js';
import {
  atomically,
  createdAtOf,
  failRemovedWebhooks,
  headOf,
  markAttemptFailed,
  markFailed,
  markSent,
  markStarted,
  pruneNotifications,
  setNextAt,
  shiftPending,
  webhookStats
} from './outbox.js';
import {
  addCount,
  clearDegradedIfIdle,
  clearNeedsAttention,
  getState,
  setDegraded,
  setNeedsAttention,
  setNextProbeAt
} from './state.js';
import type { MetricLabel } from './template.js';

export const FIRST_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 5 * 60_000;
/** While a webhook needs attention, one attempt in this long. */
export const PROBE_INTERVAL_MS = 5 * 60_000;
export const GIVE_UP_AFTER_MS = 6 * 60 * 60_000;
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
/** How long stop() waits for deliveries in progress (as the collector's shutdown does). */
export const STOP_WAIT_MS = 5_000;
/** A wall-clock move this far from monotonic time between two checks counts as a jump. */
const CLOCK_JUMP_MS = 60_000;

/** Delay before the next try, given the attempts already made: 1 → 5 s, 2 → 10 s, … capped at 5 min. */
export function retryDelay(attempts: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

interface Deliverer {
  action: AlertAction;
  timeoutMs: number;
}
interface SendOptions {
  now: () => number;
  onGiveUp?: (webhookId: string, attempts: number, reason: string) => void;
  /** Aborted on shutdown: a delivery cut short by it isn't counted as an attempt. */
  stopSignal?: AbortSignal;
}

/** Delivers the webhook's oldest pending row if it is due; resolves to whether it was sent. */
export async function sendNext(
  db: PiPulseDb,
  { action, timeoutMs }: Deliverer,
  options: SendOptions
): Promise<boolean> {
  // Read the time first: calling now() may shift pending rows (a clock jump).
  const t = options.now();
  const row = headOf(db, action.id);
  if (!row) return false;
  // The Pi has no RTC: after the clock jumps back, a retry could sit hours
  // away. Never wait longer than the longest wait we ever schedule (a Retry-After).
  if (row.nextAt - t > MAX_RETRY_AFTER_MS) {
    setNextAt(db, row.id, t + MAX_RETRY_AFTER_MS);
    return false;
  }
  if (row.nextAt > t) return false;
  // While the endpoint rejects requests outright, one attempt per probe interval: the gate
  // is persisted, so it holds across restarts and for rows that arrive later.
  const state = getState(db, action.id);
  if (state.needsAttention && state.nextProbeAt !== null) {
    if (state.nextProbeAt - t > PROBE_INTERVAL_MS) {
      setNextProbeAt(db, action.id, t + PROBE_INTERVAL_MS); // a clock that jumped back
      return false;
    }
    if (state.nextProbeAt > t) return false;
  }
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.stopSignal) signals.push(options.stopSignal);
  // Marked before the request: from here the receiver may have it, whatever happens next.
  // The probe slot is taken now too, so a crash or an abort can't allow an immediate retry.
  atomically(db, () => {
    markStarted(db, row.id, t);
    if (state.needsAttention) setNextProbeAt(db, action.id, t + PROBE_INTERVAL_MS);
  });
  try {
    await action.deliver(row.payload, AbortSignal.any(signals));
    atomically(db, () => {
      markSent(db, row.id, options.now());
      clearNeedsAttention(db, action.id);
      clearDegradedIfIdle(db, action.id);
    });
    return true;
  } catch (error) {
    // Cut short by shutdown: not the receiver's fault, so not an attempt.
    if (options.stopSignal?.aborted) return false;
    const reason = error instanceof Error ? error.message : String(error);
    const failure = error instanceof DeliveryError ? error : undefined;
    const at = options.now();
    // A summary that fails is never counted: that would make summaries about summaries.
    const count = (kind: 'rejected' | 'abandoned') => {
      if (row.event !== 'summary') addCount(db, action.id, kind, row.ruleId);
    };
    atomically(db, () => {
      // Re-read: the clock may have jumped (and the row been shifted) during the attempt.
      const createdAt = createdAtOf(db, row.id) ?? row.createdAt;
      setDegraded(db, action.id, at);
      // An HTTP answer that isn't a permanent rejection means the endpoint no longer rejects
      // outright; a transport failure says nothing either way.
      if (failure && !failure.transport && failure.kind === 'retryable')
        clearNeedsAttention(db, action.id);
      if (failure?.kind === 'permanent') {
        markFailed(db, row.id, at, reason, 'rejected');
        count('rejected');
        setNeedsAttention(db, action.id, reason, at + PROBE_INTERVAL_MS);
      } else if (at - createdAt >= GIVE_UP_AFTER_MS) {
        markFailed(db, row.id, at, reason, 'abandoned');
        count('abandoned');
        options.onGiveUp?.(action.id, row.attempts + 1, reason);
      } else {
        const wait = Math.min(
          Math.max(retryDelay(row.attempts + 1), failure?.retryAfterMs ?? 0),
          MAX_RETRY_AFTER_MS
        );
        markAttemptFailed(db, row.id, at, reason, at + wait);
      }
    });
    return false;
  }
}

/** One sendNext per webhook, in parallel; resolves to how many were sent. */
export async function sendDue(
  db: PiPulseDb,
  deliverers: Deliverer[],
  options: SendOptions
): Promise<number> {
  const sent = await Promise.all(deliverers.map((d) => sendNext(db, d, options)));
  return sent.filter(Boolean).length;
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
    /** Monotonic ms (default performance.now), to notice wall-clock jumps. */
    monotonic?: () => number;
    intervalMs?: number;
    actions?: AlertAction[];
  }
): Notifications {
  const { webhooks } = options;
  const wallNow = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const log = options.log ?? ((message: string) => console.warn(`[pipulse] ${message}`));

  // The Pi has no RTC: its clock can jump hours when NTP syncs after boot (or
  // back). Queued rows keep wall-clock times, so move them with the jump;
  // otherwise a jump forward gives up a fresh row after one try, and a jump
  // back keeps retrying a dead webhook past 6 h. Every read of the time checks.
  let lastWall = wallNow();
  let lastMono = monotonic();
  const now = () => {
    const wall = wallNow();
    const mono = monotonic();
    const jump = wall - lastWall - (mono - lastMono);
    lastWall = wall;
    lastMono = mono;
    if (Math.abs(jump) >= CLOCK_JUMP_MS) {
      try {
        const moved = shiftPending(db, jump);
        log(
          `clock jumped ${jump > 0 ? 'forward' : 'back'} ${Math.round(Math.abs(jump) / 1000)} s; ` +
            `moved ${moved} queued notification${moved === 1 ? '' : 's'} with it`
        );
      } catch (error) {
        log(`notification clock adjustment failed: ${messageOf(error)}`);
      }
    }
    return wall;
  };
  const actions = webhooks.map((webhook) => ({
    action: options.actions?.find((a) => a.id === webhook.id) ?? createWebhookAction(webhook),
    timeoutMs: webhook.timeoutMs
  }));

  failRemovedWebhooks(
    db,
    webhooks.map((w) => w.id),
    now()
  );

  // Before an attempt, a webhook that has been failing (or whose queue outgrew the cap) has
  // its backlog compacted into a recovery summary, so a recovered endpoint gets the summary
  // first and not a flood of stale messages. Never throws: a failure is logged and the
  // attempt goes ahead with the queue as it is.
  const pendingAlertRows = (id: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications WHERE webhook_id = ? AND status = 'pending' AND event <> 'summary'`
        )
        .get(id) as { n: number }
    ).n;
  const prepare = (webhook: WebhookConfig) => {
    try {
      if (
        getState(db, webhook.id).degradedSince === null &&
        pendingAlertRows(webhook.id) <= PENDING_CAP
      )
        return;
      compact(db, webhook, { now: now(), hostname: options.hostname, metrics: options.metrics });
    } catch (error) {
      log(`notification compaction failed: ${messageOf(error)}`);
    }
  };

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

  let stopped = false;
  const stopping = new AbortController();
  const sendOptions: SendOptions = {
    now,
    stopSignal: stopping.signal,
    onGiveUp: (id, n, reason) => log(`webhook ${id}: gave up after ${n} attempts (last: ${reason})`)
  };

  for (const webhook of webhooks) prepare(webhook);

  // One delivery loop per webhook, so a webhook that hangs until its timeout
  // never holds back another's queue; order only matters within one webhook.
  const lanes = actions.map((deliverer, index) => {
    const webhook = webhooks[index]!;
    let busy = false;
    let again = false;
    let running: Promise<void> | undefined;
    const drain = async () => {
      // `busy` is set before the first await and cleared right after the last
      // check, so a wake can never land in a gap and be lost.
      busy = true;
      try {
        let sent: boolean;
        do {
          again = false;
          sent = false;
          try {
            prepare(webhook);
            sent = await sendNext(db, deliverer, sendOptions);
          } catch (error) {
            log(`notification delivery failed: ${messageOf(error)}`);
          }
        } while (!stopped && (sent || again));
      } finally {
        busy = false;
      }
    };
    return {
      wake() {
        if (stopped) return;
        if (busy) {
          again = true;
          return;
        }
        running = drain();
      },
      done: () => running
    };
  });

  const wake = () => {
    if (stopped) return;
    maybePrune();
    for (const lane of lanes) lane.wake();
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
      stopping.abort();
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(lanes.map((lane) => lane.done())),
        new Promise((resolve) => (giveUp = setTimeout(resolve, STOP_WAIT_MS)))
      ]);
      clearTimeout(giveUp);
    }
  };
}
