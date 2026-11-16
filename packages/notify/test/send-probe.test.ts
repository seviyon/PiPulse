import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { DeliveryError, type AlertAction } from '../src/action.js';
import { insertNotification } from '../src/outbox.js';
import { PROBE_INTERVAL_MS, sendProbe } from '../src/sender.js';
import { addCount, getState, hasUnsummarized, setNeedsAttention } from '../src/state.js';

// sendProbe by itself, with the clock in the test's hands: each case is one thing the probe must
// do or must not do.

const T = 100_000_000_000;
let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

type Behaviour = 'ok' | 'hang' | Error;
function action(behaviour: Behaviour = 'ok') {
  const calls: string[] = [];
  const deliverer: AlertAction = {
    id: 'a',
    apiVersion: 1,
    async deliver(payload, signal) {
      calls.push(payload);
      if (behaviour === 'ok') return;
      if (behaviour === 'hang')
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        );
      throw behaviour;
    }
  };
  return { calls, deliverer: { action: deliverer, timeoutMs: 1000 } };
}
const refused = (probeAt = T - 1000) => {
  setNeedsAttention(db, 'a', 'HTTP 401', probeAt);
  addCount(db, 'a', 'rejected', 'cpu_busy', 2);
};
const build = () => '{"summary":true}';
const probe = (
  a: ReturnType<typeof action>,
  options: { stopSignal?: AbortSignal; make?: () => string | undefined; now?: () => number } = {}
) =>
  sendProbe(db, a.deliverer, options.make ?? build, {
    now: options.now ?? (() => T),
    ...(options.stopSignal ? { stopSignal: options.stopSignal } : {})
  });
const permanent = (message: string) =>
  new DeliveryError(message, { kind: 'permanent', transport: false });
const retryable = (message: string, transport = false) =>
  new DeliveryError(message, { kind: 'retryable', transport });

describe('sendProbe', () => {
  it('delivers the summary, answers true, and spends the counts and the refusal', async () => {
    refused();
    const a = action();
    expect(await probe(a)).toBe(true);
    expect(a.calls).toEqual(['{"summary":true}']);
    expect(hasUnsummarized(db, 'a')).toBe(false);
    expect(getState(db, 'a')).toMatchObject({ needsAttention: false, lastSummaryAt: T });
  });

  it('does nothing while a row is waiting: that row is the probe', async () => {
    refused();
    insertNotification(db, {
      webhookId: 'a',
      alertId: 1,
      event: 'raised',
      ruleId: 'r',
      metric: 'm',
      payload: '{}',
      nextAt: T,
      createdAt: T
    });
    const a = action();
    expect(await probe(a)).toBe(false);
    expect(a.calls).toEqual([]);
  });

  it('does nothing before the probe time, and pulls one far ahead (a clock that went back) to five minutes', async () => {
    refused(T + 3 * 60 * 60_000);
    const a = action();
    expect(await probe(a)).toBe(false);
    expect(a.calls).toEqual([]);
    expect(getState(db, 'a').nextProbeAt).toBe(T + PROBE_INTERVAL_MS);
    expect(await probe(a, { now: () => T + 2 * 60_000 })).toBe(false); // five minutes not yet up
    expect(await probe(a, { now: () => T + PROBE_INTERVAL_MS })).toBe(true);
  });

  it('does nothing when there is nothing to say', async () => {
    refused(T - 1000);
    const a = action();
    expect(await probe(a, { make: () => undefined })).toBe(false);
    expect(a.calls).toEqual([]);
    expect(getState(db, 'a').nextProbeAt).toBe(T - 1000); // the slot was not taken
  });

  it('gives up on a request that takes longer than its timeout, and takes the slot', async () => {
    refused();
    const hanging = action('hang');
    hanging.deliverer.timeoutMs = 20;
    expect(await probe(hanging)).toBe(false);
    expect(getState(db, 'a')).toMatchObject({
      needsAttention: true,
      degradedSince: T,
      nextProbeAt: T + PROBE_INTERVAL_MS
    });
    expect(hasUnsummarized(db, 'a')).toBe(true);
  });

  it('is cut short by a shutdown without being counted a failure', async () => {
    refused();
    const hanging = action('hang');
    const stop = new AbortController();
    const pending = probe(hanging, { stopSignal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = performance.now();
    stop.abort();
    expect(await pending).toBe(false);
    // Cut short at once, not after the request's own timeout (a second here).
    expect(performance.now() - before).toBeLessThan(500);
    expect(getState(db, 'a')).toMatchObject({
      needsAttention: true,
      degradedSince: null, // nothing went wrong that a shutdown did not cause
      nextProbeAt: T + PROBE_INTERVAL_MS // and the slot stays taken
    });
    expect(hasUnsummarized(db, 'a')).toBe(true);
  });

  it('takes the new reason from a permanent refusal, and a new slot', async () => {
    refused();
    const a = action(permanent('HTTP 403'));
    expect(await probe(a)).toBe(false);
    expect(getState(db, 'a')).toMatchObject({
      needsAttention: true,
      reason: 'HTTP 403',
      degradedSince: T,
      nextProbeAt: T + PROBE_INTERVAL_MS
    });
    expect(getState(db, 'a').counts.rejected).toBe(2); // a probe is not counted
  });

  it('ends the refusal on a status that can be retried, and keeps the counts for the ordinary path', async () => {
    refused();
    expect(await probe(action(retryable('HTTP 503')))).toBe(false);
    expect(getState(db, 'a')).toMatchObject({ needsAttention: false, degradedSince: T });
    expect(hasUnsummarized(db, 'a')).toBe(true);
  });

  it('keeps the refusal through a transport failure and through an error that is not a DeliveryError', async () => {
    refused();
    expect(await probe(action(retryable('timeout', true)))).toBe(false);
    expect(getState(db, 'a')).toMatchObject({ needsAttention: true, reason: 'HTTP 401' });
    expect(await probe(action(new Error('boom')), { now: () => T + PROBE_INTERVAL_MS })).toBe(
      false
    );
    expect(getState(db, 'a')).toMatchObject({ needsAttention: true, reason: 'HTTP 401' });
    expect(hasUnsummarized(db, 'a')).toBe(true);
  });

  it('does nothing for a webhook that is not refused, or has no counts', async () => {
    addCount(db, 'a', 'rejected', 'r');
    const notRefused = action();
    expect(await probe(notRefused)).toBe(false);
    expect(notRefused.calls).toEqual([]);
    db.exec('DELETE FROM webhook_summary_counts');
    setNeedsAttention(db, 'a', 'HTTP 401', T - 1000);
    const nothing = action();
    expect(await probe(nothing)).toBe(false);
    expect(nothing.calls).toEqual([]);
  });
});
