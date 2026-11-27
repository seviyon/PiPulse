import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { addCount, getState, setDegraded, setNeedsAttention } from '../src/state.js';
import {
  deletePendingClears,
  failRemovedWebhooks,
  headOf,
  insertNotification,
  markAttemptFailed,
  markFailed,
  markStarted,
  shiftPending,
  markSent,
  pruneNotifications,
  setNextAt,
  webhookStats
} from '../src/outbox.js';

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const row = (over: Partial<Parameters<typeof insertNotification>[1]> = {}) => ({
  webhookId: 'apprise',
  alertId: 1,
  event: 'raised' as const,
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  payload: '{}',
  nextAt: 1000,
  createdAt: 1000,
  ...over
});

describe('outbox', () => {
  it('serves the oldest pending row per webhook and moves on once it is sent', () => {
    insertNotification(db, row());
    insertNotification(db, row({ event: 'cleared' }));
    insertNotification(db, row({ webhookId: 'ntfy' }));
    const first = headOf(db, 'apprise')!;
    expect(first).toMatchObject({ event: 'raised', status: 'pending', attempts: 0 });
    markSent(db, first.id, 2000);
    expect(headOf(db, 'apprise')).toMatchObject({ event: 'cleared' });
    expect(headOf(db, 'ntfy')).toMatchObject({ webhookId: 'ntfy' });
  });

  it('records failed attempts and giving up, and reports them in the stats', () => {
    insertNotification(db, row());
    const head = headOf(db, 'apprise')!;
    markAttemptFailed(db, head.id, 1500, 'HTTP 503', 6500);
    expect(headOf(db, 'apprise')).toMatchObject({
      attempts: 1,
      nextAt: 6500,
      lastError: 'HTTP 503',
      failedAt: 1500
    });
    setNextAt(db, head.id, 7000);
    expect(headOf(db, 'apprise')!.nextAt).toBe(7000);
    markFailed(db, head.id, 9000, 'timeout', 'abandoned');
    expect(headOf(db, 'apprise')).toBeUndefined();
    expect(webhookStats(db, 'apprise')).toEqual({
      pending: 0,
      lastSuccessAt: null,
      lastFailure: { at: 9000, reason: 'timeout' }
    });
  });

  it('keeps the latest failure after a later success', () => {
    insertNotification(db, row());
    const head = headOf(db, 'apprise')!;
    markAttemptFailed(db, head.id, 1500, 'timeout', 1600);
    markSent(db, head.id, 1700);
    insertNotification(db, row({ createdAt: 1800, nextAt: 1800 }));
    expect(webhookStats(db, 'apprise')).toEqual({
      pending: 1,
      lastSuccessAt: 1700,
      lastFailure: { at: 1500, reason: 'timeout' }
    });
  });

  it("deletes one alert's pending clears for the given webhooks only", () => {
    insertNotification(db, row({ event: 'cleared', alertId: 7 }));
    insertNotification(db, row({ event: 'cleared', alertId: 7, webhookId: 'ntfy' }));
    insertNotification(db, row({ event: 'cleared', alertId: 6 }));
    insertNotification(db, row({ event: 'raised', alertId: 7 }));
    expect(deletePendingClears(db, 7, [])).toBe(0);
    expect(deletePendingClears(db, 7, ['apprise'])).toBe(1);
    expect(headOf(db, 'apprise')).toMatchObject({ event: 'cleared', alertId: 6 });
    expect(headOf(db, 'ntfy')).toMatchObject({ event: 'cleared', alertId: 7 });
  });

  it("drops an alert's pending clears for every webhook asked for", () => {
    insertNotification(db, row({ event: 'cleared', alertId: 7 }));
    insertNotification(db, row({ event: 'cleared', alertId: 7, webhookId: 'ntfy' }));
    insertNotification(db, row({ event: 'cleared', alertId: 7, webhookId: 'other' }));
    expect(deletePendingClears(db, 7, ['apprise', 'ntfy'])).toBe(2);
    expect(headOf(db, 'other')).toMatchObject({ event: 'cleared', alertId: 7 });
  });

  it('fails pending rows of removed webhooks and prunes finished rows', () => {
    insertNotification(db, row({ webhookId: 'gone' }));
    insertNotification(db, row());
    expect(failRemovedWebhooks(db, ['apprise'], 5000)).toBe(1);
    expect(webhookStats(db, 'gone').lastFailure).toEqual({ at: 5000, reason: 'webhook removed' });
    markSent(db, headOf(db, 'apprise')!.id, 6000);
    expect(pruneNotifications(db, 5500)).toBe(1); // the 'gone' row finished at 5000
    expect(pruneNotifications(db, 7000)).toBe(1);
  });
});

describe('started rows, failed kinds and head order', () => {
  const rowsOf = () =>
    db
      .prepare(
        'SELECT id, event, status, started_at AS startedAt, failed_kind AS failedKind, last_error AS lastError FROM notifications ORDER BY id'
      )
      .all();

  it('puts a started row first, then a summary, then the rest by id', () => {
    insertNotification(db, row({ createdAt: 1 }));
    insertNotification(db, row({ createdAt: 2 }));
    insertNotification(db, row({ createdAt: 3 }));
    db.prepare(
      "INSERT INTO notifications (webhook_id, alert_id, event, rule_id, metric, payload, next_at, created_at) VALUES ('apprise', 0, 'summary', '', '', '{}', 1, 4)"
    ).run();
    expect(headOf(db, 'apprise')).toMatchObject({ event: 'summary' });
    const [first, second, third] = rowsOf() as { id: number }[];
    markStarted(db, third!.id, 10);
    expect(headOf(db, 'apprise')).toMatchObject({ id: third!.id, startedAt: 10 });
    markStarted(db, third!.id, 20);
    expect(headOf(db, 'apprise')!.startedAt).toBe(20); // set again, never cleared
    db.prepare('DELETE FROM notifications WHERE id = ?').run(third!.id);
    expect(headOf(db, 'apprise')).toMatchObject({ event: 'summary' });
    expect([first, second]).toHaveLength(2);
  });

  it('marks a failed row with its kind and reason', () => {
    insertNotification(db, row());
    const head = headOf(db, 'apprise')!;
    markFailed(db, head.id, 5000, 'HTTP 401', 'rejected');
    expect(rowsOf()[0]).toMatchObject({
      status: 'failed',
      failedKind: 'rejected',
      lastError: 'HTTP 401'
    });
    expect(headOf(db, 'apprise')).toBeUndefined();
  });

  it('shifts started_at of pending rows with a clock jump, and leaves finished rows alone', () => {
    insertNotification(db, row({ createdAt: 100, nextAt: 100 }));
    insertNotification(db, row({ createdAt: 200, nextAt: 200 }));
    const [a, b] = rowsOf() as { id: number }[];
    markStarted(db, a!.id, 150);
    markSent(db, b!.id, 250);
    markStarted(db, b!.id, 240);
    expect(shiftPending(db, 1000)).toBe(1);
    const after = rowsOf() as { id: number; startedAt: number }[];
    expect(after.find((r) => r.id === a!.id)!.startedAt).toBe(1150);
    expect(after.find((r) => r.id === b!.id)!.startedAt).toBe(240);
  });
});

describe('outbox and webhook state together', () => {
  it('shifts the webhook state with the pending rows on a clock jump', () => {
    setDegraded(db, 'apprise', 1000);
    setNeedsAttention(db, 'apprise', 'HTTP 401', 2000);
    shiftPending(db, 500);
    expect(getState(db, 'apprise')).toMatchObject({ degradedSince: 1500, nextProbeAt: 2500 });
  });

  it('forgets the state and counts of a removed webhook when failing its rows', () => {
    insertNotification(db, row({ webhookId: 'gone' }));
    insertNotification(db, row({ webhookId: 'kept' }));
    addCount(db, 'gone', 'rejected', 'r');
    addCount(db, 'kept', 'rejected', 'r');
    expect(failRemovedWebhooks(db, ['kept'], 5000)).toBe(1);
    expect(getState(db, 'gone').counts.rejected).toBe(0);
    expect(getState(db, 'kept').counts.rejected).toBe(1);
  });
});
