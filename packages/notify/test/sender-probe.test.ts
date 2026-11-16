import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { DeliveryError, type AlertAction } from '../src/action.js';
import type { WebhookConfig } from '../src/config.js';
import { insertNotification } from '../src/outbox.js';
import { startNotifications, type Notifications } from '../src/sender.js';
import {
  addCount,
  getState,
  hasUnsummarized,
  setDegraded,
  setNeedsAttention
} from '../src/state.js';

// A webhook that was refused outright keeps what happened as counts. With nothing queued there is
// no row to try the endpoint with, so a probe delivers the recovery summary itself, every five
// minutes, and spends the counts only when the endpoint accepts it.

const MIN = 60_000;
let db: PiPulseDb;
let wall: number;
let mono: number;
let started: Notifications[];
beforeEach(() => {
  db = openDb(':memory:');
  wall = 100_000_000_000;
  mono = 0;
  started = [];
});
afterEach(async () => {
  for (const n of started) await n.stop();
  db.close();
});

const hook = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  id: 'a',
  url: 'http://x',
  method: 'POST',
  headers: {},
  events: ['raised', 'cleared'],
  minSeverity: 'warning',
  timeoutMs: 1000,
  ...over
});
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome =
  'ok' | 'hang' | { message: string; kind: 'permanent' | 'retryable'; transport?: boolean };
/** Answers from a script and records every payload it is asked to send, answered or not. */
function scripted(outcomes: Outcome[]) {
  const calls: string[] = [];
  const action: AlertAction = {
    id: 'a',
    apiVersion: 1,
    async deliver(payload, signal) {
      calls.push(payload);
      const outcome = outcomes.shift() ?? 'ok';
      if (outcome === 'ok') return;
      if (outcome === 'hang')
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('x')))
        );
      throw new DeliveryError(outcome.message, {
        kind: outcome.kind,
        transport: outcome.transport ?? false
      });
    }
  };
  return { action, calls };
}
const start = (action: AlertAction, webhook = hook()) => {
  const n = startNotifications(db, {
    webhooks: [webhook],
    hostname: 'Io',
    metrics: [],
    now: () => wall,
    monotonic: () => mono,
    intervalMs: 20,
    actions: [action],
    log: () => {}
  });
  started.push(n);
  return n;
};
const advance = async (ms: number) => {
  wall += ms;
  mono += ms;
  await wait();
};
/** Refused a moment ago, two refusals counted, nothing left to send. */
function refused(probeAt = wall - MIN) {
  setNeedsAttention(db, 'a', 'HTTP 401', probeAt);
  setDegraded(db, 'a', wall - 40 * MIN);
  addCount(db, 'a', 'rejected', 'cpu_busy', 2);
}
const refusedOnce: Outcome = { message: 'HTTP 401', kind: 'permanent' };
const summarySent = (payload: string) => JSON.parse(payload).body as string;

describe('the probe, with nothing queued', () => {
  it('delivers the summary to an endpoint that answers again, and then spends the counts', async () => {
    refused();
    const { action, calls } = scripted(['ok']);
    start(action);
    await wait();
    expect(calls).toHaveLength(1);
    expect(summarySent(calls[0]!)).toContain('2 notifications were rejected by the endpoint');
    expect(hasUnsummarized(db, 'a')).toBe(false);
    expect(getState(db, 'a')).toMatchObject({
      needsAttention: false,
      degradedSince: null,
      lastSummaryAt: wall,
      counts: { rejected: 2 } // the lifetime total stays
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
  });

  it('lists what is open now, like any summary', async () => {
    refused();
    db.prepare(
      "INSERT INTO alerts (rule_id, metric, severity, message, value, raised_at) VALUES ('swap_full', 'swap_used', 'critical', 'm', 1, ?)"
    ).run(wall - 5 * MIN);
    const { action, calls } = scripted(['ok']);
    start(action);
    await wait();
    expect(summarySent(calls[0]!)).toContain('still open: swap_full (critical)');
  });

  it('waits for the probe time, and tries once it comes', async () => {
    refused(wall + 3 * MIN);
    const { action, calls } = scripted(['ok']);
    start(action);
    await wait();
    expect(calls).toHaveLength(0);
    await advance(3 * MIN);
    expect(calls).toHaveLength(1);
  });

  it('sends nothing when there is nothing to report, or when the webhook is not refused', async () => {
    setNeedsAttention(db, 'a', 'HTTP 401', wall - MIN); // refused, but no counts
    const none = scripted(['ok']);
    start(none.action);
    await wait();
    expect(none.calls).toHaveLength(0);
  });

  it('leaves a webhook that is not refused to the ordinary path', async () => {
    addCount(db, 'a', 'rejected', 'cpu_busy');
    const { action, calls } = scripted(['ok']);
    start(action); // counts, not refused, not degraded: no summary until something degrades it
    await wait();
    expect(calls).toHaveLength(0);
  });
});

describe('the probe, when the endpoint does not take it', () => {
  it('keeps the counts and the state while it is still refused, and tries again in five minutes', async () => {
    refused();
    const { action, calls } = scripted([refusedOnce, 'ok']);
    start(action);
    await wait();
    expect(calls).toHaveLength(1);
    expect(hasUnsummarized(db, 'a')).toBe(true);
    expect(getState(db, 'a')).toMatchObject({
      needsAttention: true,
      reason: 'HTTP 401',
      nextProbeAt: wall + 5 * MIN,
      counts: { rejected: 2 } // a probe is not a notification: nothing is counted for it
    });
    await advance(2 * MIN);
    expect(calls).toHaveLength(1); // not yet
    await advance(3 * MIN);
    expect(calls).toHaveLength(2);
    expect(hasUnsummarized(db, 'a')).toBe(false);
  });

  it('keeps waiting through a transport failure, one try per slot', async () => {
    refused();
    const { action, calls } = scripted([
      { message: 'timeout', kind: 'retryable', transport: true },
      { message: 'timeout', kind: 'retryable', transport: true },
      'ok'
    ]);
    start(action);
    await wait();
    expect(getState(db, 'a')).toMatchObject({ needsAttention: true, nextProbeAt: wall + 5 * MIN });
    expect(hasUnsummarized(db, 'a')).toBe(true);
    await advance(MIN); // the row's own ladder is not in play: only the slot
    expect(calls).toHaveLength(1);
    await advance(4 * MIN);
    expect(calls).toHaveLength(2);
    await advance(5 * MIN);
    expect(calls).toHaveLength(3);
    expect(hasUnsummarized(db, 'a')).toBe(false);
  });

  it('keeps waiting when the endpoint answers with a status that can be retried: one request per slot', async () => {
    refused();
    const { action, calls } = scripted([{ message: 'HTTP 503', kind: 'retryable' }, 'ok']);
    start(action);
    await wait(150);
    expect(calls).toHaveLength(1); // no second request a moment later
    expect(getState(db, 'a')).toMatchObject({ needsAttention: true, nextProbeAt: wall + 5 * MIN });
    expect(hasUnsummarized(db, 'a')).toBe(true);
    await advance(5 * MIN);
    expect(calls).toHaveLength(2);
    expect(summarySent(calls[1]!)).toContain('2 notifications were rejected by the endpoint');
    expect(getState(db, 'a')).toMatchObject({ needsAttention: false, degradedSince: null });
    expect(hasUnsummarized(db, 'a')).toBe(false);
  });

  it('keeps the counts when a shutdown cuts the probe short, and does not try again at once', async () => {
    refused();
    const { action, calls } = scripted(['hang']);
    const n = start(action);
    await wait();
    expect(calls).toHaveLength(1);
    await n.stop();
    expect(hasUnsummarized(db, 'a')).toBe(true);
    expect(getState(db, 'a')).toMatchObject({ needsAttention: true, nextProbeAt: wall + 5 * MIN });
  });
});

describe('the probe and the queue', () => {
  it('stays out of the way while rows are waiting: they are the probe', async () => {
    refused();
    insertNotification(db, {
      webhookId: 'a',
      alertId: 1,
      event: 'raised',
      ruleId: 'r',
      metric: 'm',
      payload: JSON.stringify({ event: 'raised' }),
      nextAt: wall,
      createdAt: wall
    });
    const { action, calls } = scripted(['ok', 'ok']);
    start(action);
    await wait(150);
    expect(JSON.parse(calls[0]!)).toMatchObject({ event: 'raised' });
    expect(calls).toHaveLength(2); // then the summary, through the ordinary path
    expect(hasUnsummarized(db, 'a')).toBe(false);
  });

  it('does not probe in the same pass that refused the last queued row: that refusal took the slot', async () => {
    insertNotification(db, {
      webhookId: 'a',
      alertId: 1,
      event: 'raised',
      ruleId: 'r',
      metric: 'm',
      payload: JSON.stringify({ event: 'raised' }),
      nextAt: wall,
      createdAt: wall
    });
    const { action, calls } = scripted([refusedOnce, 'ok']);
    start(action);
    await wait(150);
    expect(calls).toHaveLength(1); // the row, refused; its counts wait, no second request
    expect(getState(db, 'a')).toMatchObject({ needsAttention: true, nextProbeAt: wall + 5 * MIN });
    expect(hasUnsummarized(db, 'a')).toBe(true);
    await advance(5 * MIN);
    expect(calls).toHaveLength(2); // the probe, with the summary
    expect(summarySent(calls[1]!)).toContain('1 notification was rejected by the endpoint');
  });

  it('works for a webhook that has a body template, rendering the summary through it', async () => {
    refused();
    const { action, calls } = scripted(['ok']);
    start(action, hook({ body: { text: '{{event}}: {{message}}' } }));
    await wait();
    expect(JSON.parse(calls[0]!).text).toContain('summary: 2 notifications were rejected');
  });
});
