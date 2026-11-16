import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { clearAlert, raiseAlert } from '@pipulse/alerts';
import type { AlertAction } from '../src/action.js';
import type { WebhookConfig } from '../src/config.js';
import { insertNotification } from '../src/outbox.js';
import { startNotifications, type Notifications } from '../src/sender.js';
import {
  addCount,
  getState,
  hasUnsummarized,
  markSummary,
  setDegraded,
  setNeedsAttention
} from '../src/state.js';

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

const hook = (id = 'a'): WebhookConfig => ({
  id,
  url: 'http://x',
  method: 'POST',
  headers: {},
  events: ['raised', 'cleared'],
  minSeverity: 'warning',
  timeoutMs: 1000
});
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records what it is asked to send; with `hang` it never answers until aborted. */
function recorder(id = 'a', hang = false) {
  const payloads: string[] = [];
  const action: AlertAction = {
    id,
    apiVersion: 1,
    async deliver(payload, signal) {
      payloads.push(payload);
      if (hang)
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('x')))
        );
    }
  };
  return { action, payloads };
}
const start = (actions: AlertAction[], webhooks = [hook()], intervalMs = 20) => {
  const n = startNotifications(db, {
    webhooks,
    hostname: 'Io',
    metrics: [],
    now: () => wall,
    monotonic: () => mono,
    intervalMs,
    actions,
    log: () => {}
  });
  started.push(n);
  return n;
};

let seq = 0;
/** An alert and its raise (and, once cleared, its clear) queued for webhook `webhookId`. */
function episode(webhookId: string, raisedAgo: number, clearedAgo?: number) {
  const rule = `rule_${seq++}`;
  const alert = raiseAlert(db, {
    ruleId: rule,
    metric: `m_${rule}`,
    severity: 'warning',
    message: rule,
    value: 1,
    raisedAt: wall - raisedAgo
  });
  const add = (event: 'raised' | 'cleared', at: number) =>
    insertNotification(db, {
      webhookId,
      alertId: alert.id,
      event,
      ruleId: rule,
      metric: alert.metric,
      payload: JSON.stringify({ event, rule }),
      nextAt: at,
      createdAt: at
    });
  add('raised', wall - raisedAgo);
  if (clearedAgo !== undefined) {
    clearAlert(db, alert.id, wall - clearedAgo, 'condition');
    add('cleared', wall - clearedAgo);
  }
  return alert;
}
const summaryRows = (id = 'a') =>
  db
    .prepare(
      "SELECT id, status, started_at AS startedAt FROM notifications WHERE webhook_id = ? AND event = 'summary'"
    )
    .all(id) as {
    id: number;
    status: string;
    startedAt: number | null;
  }[];
const isSummary = (payload: string) => payload.includes('notifications were delayed');

describe('compaction before delivery', () => {
  it('sends the summary before the rest of a recovered backlog, even for a recent under-cap queue', async () => {
    episode('a', 30 * MIN, 20 * MIN); // opened and cleared during the outage
    episode('a', 8 * MIN); // still open
    setNeedsAttention(db, 'a', 'HTTP 401', wall - MIN); // the endpoint rejected us a moment ago...
    setDegraded(db, 'a', wall - 40 * MIN);
    const good = recorder();
    start([good.action]);
    await wait();
    expect(good.payloads).toHaveLength(2);
    expect(isSummary(good.payloads[0]!)).toBe(true);
    expect(JSON.parse(good.payloads[1]!)).toMatchObject({ event: 'raised' });
    expect(JSON.parse(good.payloads[0]!).body).toContain('1 alert opened and cleared');
    expect(getState(db, 'a').degradedSince).toBeNull(); // queue drained after a success
  });

  it('compacts at startup when the webhook was degraded, before any attempt can finish', async () => {
    episode('a', 30 * MIN, 20 * MIN);
    setDegraded(db, 'a', wall - 40 * MIN);
    const hanging = recorder('a', true);
    start([hanging.action]);
    await wait();
    expect(summaryRows()).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE event <> 'summary'").get()
    ).toEqual({ n: 0 });
  });

  it('sends exactly one summary across a stop and a restart', async () => {
    episode('a', 30 * MIN, 20 * MIN);
    setDegraded(db, 'a', wall - 40 * MIN);
    const first = recorder('a', true);
    const n = start([first.action]);
    await wait();
    await n.stop(); // the summary's delivery was cut short: started, unreported, still pending
    expect(first.payloads).toHaveLength(1);
    const second = recorder();
    start([second.action]);
    await wait();
    expect(second.payloads.filter(isSummary)).toHaveLength(1);
    expect(summaryRows()).toHaveLength(1);
    expect(hasUnsummarized(db, 'a')).toBe(false);
  });

  it('leaves a healthy webhook alone: no compaction below the cap, rows sent in order', async () => {
    episode('a', 30 * MIN, 20 * MIN);
    const good = recorder();
    start([good.action]);
    await wait();
    expect(good.payloads.map((p) => JSON.parse(p).event)).toEqual(['raised', 'cleared']);
    expect(summaryRows()).toEqual([]);
  });
});

describe('removed webhooks', () => {
  it('fails their rows and forgets their state, counts and pending summary', async () => {
    episode('gone', 30 * MIN, 20 * MIN);
    addCount(db, 'gone', 'rejected', 'cpu_busy');
    setDegraded(db, 'gone', wall - 40 * MIN);
    db.prepare(
      "INSERT INTO notifications (webhook_id, alert_id, event, rule_id, metric, payload, next_at, created_at) VALUES ('gone', 0, 'summary', '', '', '{}', 1, 1)"
    ).run();
    const good = recorder();
    start([good.action]);
    await wait();
    expect(good.payloads).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT DISTINCT status, last_error AS e FROM notifications WHERE webhook_id = 'gone'"
        )
        .all()
    ).toEqual([{ status: 'failed', e: 'webhook removed' }]);
    expect(getState(db, 'gone')).toMatchObject({ degradedSince: null, counts: { rejected: 0 } });
    expect(hasUnsummarized(db, 'gone')).toBe(false);
  });

  it('forgets removed webhooks even when none are configured at all', () => {
    addCount(db, 'gone', 'dropped', 'r');
    startNotifications(db, {
      webhooks: [],
      hostname: 'Io',
      metrics: [],
      now: () => wall,
      log: () => {}
    });
    expect(getState(db, 'gone').counts.dropped).toBe(0);
  });
});

describe('a wall-clock jump during an outage', () => {
  it('moves queued rows with it, so nothing becomes eligible just because the clock jumped', async () => {
    episode('a', 4 * MIN, 1 * MIN); // young pair
    setDegraded(db, 'a', wall - 4 * MIN);
    const hanging = recorder('a', true);
    start([hanging.action]);
    await wait();
    wall += 60 * MIN; // NTP steps the clock an hour ahead; monotonic time barely moves
    mono += 100;
    await wait(80);
    expect(summaryRows()).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE event <> 'summary'").get()
    ).toEqual({ n: 2 });
  });
});

describe('status', () => {
  it('reports needs attention, the degraded time, the lifetime counts and the last summary', () => {
    expect(start([recorder().action]).status()[0]).toMatchObject({
      needsAttention: null,
      degradedSince: null,
      counts: { openedAndCleared: 0, cleared: 0, rejected: 0, abandoned: 0, dropped: 0 },
      lastSummaryAt: null
    });
    setNeedsAttention(db, 'a', 'HTTP 401', wall + 5 * MIN);
    setDegraded(db, 'a', wall - MIN);
    addCount(db, 'a', 'opened_and_cleared', 'r', 3);
    addCount(db, 'a', 'cleared', 'r', 1);
    addCount(db, 'a', 'rejected', 'r', 2);
    addCount(db, 'a', 'abandoned', 'r', 4);
    addCount(db, 'a', 'dropped', 'r', 5);
    markSummary(db, 'a', wall);
    const n = startNotifications(db, {
      webhooks: [hook()],
      hostname: 'Io',
      metrics: [],
      now: () => wall,
      intervalMs: 1e9,
      actions: [recorder('a', true).action],
      log: () => {}
    });
    started.push(n);
    expect(n.status()[0]).toMatchObject({
      needsAttention: { reason: 'HTTP 401' },
      degradedSince: wall - MIN,
      counts: { openedAndCleared: 3, cleared: 1, rejected: 2, abandoned: 4, dropped: 5 },
      lastSummaryAt: wall
    });
  });
});
