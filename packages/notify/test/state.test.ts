import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { insertNotification } from '../src/outbox.js';
import {
  addCount,
  clearDegradedIfIdle,
  clearNeedsAttention,
  deleteStateExcept,
  getState,
  hasUnsummarized,
  markSummary,
  setDegraded,
  setNeedsAttention,
  setNextProbeAt,
  shiftState,
  takeUnsummarized
} from '../src/state.js';

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const pending = (webhookId = 'w') =>
  insertNotification(db, {
    webhookId,
    alertId: 1,
    event: 'raised',
    ruleId: 'r',
    metric: 'm',
    payload: '{}',
    nextAt: 1,
    createdAt: 1
  });

describe('webhook state', () => {
  it('defaults when the webhook has no row', () => {
    expect(getState(db, 'w')).toEqual({
      webhookId: 'w',
      degradedSince: null,
      needsAttention: false,
      reason: null,
      nextProbeAt: null,
      counts: { opened_and_cleared: 0, cleared: 0, rejected: 0, abandoned: 0, dropped: 0 },
      lastSummaryAt: null
    });
  });

  it('sets degraded once and clears it only when no row is pending', () => {
    setDegraded(db, 'w', 100);
    setDegraded(db, 'w', 200);
    expect(getState(db, 'w').degradedSince).toBe(100);
    pending();
    clearDegradedIfIdle(db, 'w');
    expect(getState(db, 'w').degradedSince).toBe(100);
    db.prepare('DELETE FROM notifications').run();
    clearDegradedIfIdle(db, 'w');
    expect(getState(db, 'w').degradedSince).toBeNull();
  });

  it('sets and clears needs attention and moves the probe time', () => {
    setNeedsAttention(db, 'w', 'HTTP 401', 500);
    expect(getState(db, 'w')).toMatchObject({
      needsAttention: true,
      reason: 'HTTP 401',
      nextProbeAt: 500
    });
    setNextProbeAt(db, 'w', 900);
    expect(getState(db, 'w').nextProbeAt).toBe(900);
    clearNeedsAttention(db, 'w');
    expect(getState(db, 'w')).toMatchObject({ needsAttention: false, reason: null });
  });

  it('counts lifetime and per rule, and takes the per-rule counts once', () => {
    expect(hasUnsummarized(db, 'w')).toBe(false);
    addCount(db, 'w', 'rejected', 'cpu_busy');
    addCount(db, 'w', 'rejected', 'cpu_busy');
    addCount(db, 'w', 'opened_and_cleared', 'disk_full', 3);
    expect(getState(db, 'w').counts).toMatchObject({ rejected: 2, opened_and_cleared: 3 });
    expect(hasUnsummarized(db, 'w')).toBe(true);
    const taken = takeUnsummarized(db, 'w');
    expect(taken).toEqual(
      expect.arrayContaining([
        { kind: 'rejected', ruleId: 'cpu_busy', n: 2 },
        { kind: 'opened_and_cleared', ruleId: 'disk_full', n: 3 }
      ])
    );
    expect(taken).toHaveLength(2);
    expect(takeUnsummarized(db, 'w')).toEqual([]);
    expect(getState(db, 'w').counts.rejected).toBe(2); // lifetime stays
  });

  it('records the summary time', () => {
    markSummary(db, 'w', 777);
    expect(getState(db, 'w').lastSummaryAt).toBe(777);
  });

  it('deletes the state and counts of webhooks not kept', () => {
    addCount(db, 'a', 'dropped', 'r');
    addCount(db, 'b', 'dropped', 'r');
    deleteStateExcept(db, ['a']);
    expect(getState(db, 'b').counts.dropped).toBe(0);
    expect(hasUnsummarized(db, 'b')).toBe(false);
    expect(getState(db, 'a').counts.dropped).toBe(1);
    deleteStateExcept(db, []);
    expect(getState(db, 'a').counts.dropped).toBe(0);
  });

  it('shifts the set times and leaves unset ones null', () => {
    setDegraded(db, 'w', 1000);
    setNeedsAttention(db, 'w', 'x', 2000);
    shiftState(db, 500);
    expect(getState(db, 'w')).toMatchObject({
      degradedSince: 1500,
      nextProbeAt: 2500,
      lastSummaryAt: null
    });
  });
});
