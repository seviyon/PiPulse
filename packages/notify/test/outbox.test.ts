import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import {
  deletePendingClears,
  failRemovedWebhooks,
  headOf,
  insertNotification,
  markAttemptFailed,
  markGivenUp,
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
    markGivenUp(db, head.id, 9000, 'timeout');
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

  it('deletes pending clears for one rule and metric', () => {
    insertNotification(db, row({ event: 'cleared' }));
    insertNotification(db, row({ event: 'cleared', metric: 'other' }));
    insertNotification(db, row({ event: 'raised' }));
    expect(deletePendingClears(db, 'cpu_hot', 'cpu_temperature')).toBe(1);
    expect(headOf(db, 'apprise')).toMatchObject({ event: 'cleared', metric: 'other' });
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
