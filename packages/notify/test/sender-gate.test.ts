import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { DeliveryError, type AlertAction } from '../src/action.js';
import { insertNotification, shiftPending } from '../src/outbox.js';
import { PROBE_INTERVAL_MS, sendDue } from '../src/sender.js';
import { getState, setNeedsAttention } from '../src/state.js';

let db: PiPulseDb;
let now: number;
beforeEach(() => {
  db = openDb(':memory:');
  now = 1_000_000;
});
afterEach(() => db.close());

const add = () =>
  insertNotification(db, {
    webhookId: 'a',
    alertId: 1,
    event: 'raised',
    ruleId: 'r',
    metric: 'm',
    payload: '{}',
    nextAt: now,
    createdAt: now
  });

type Outcome =
  'ok' | 'hang' | { message: string; kind: 'permanent' | 'retryable'; transport?: boolean };
const permanent: Outcome = { message: 'HTTP 401', kind: 'permanent' };
const transport: Outcome = { message: 'timeout', kind: 'retryable', transport: true };
const http503: Outcome = { message: 'HTTP 503', kind: 'retryable' };

/** An action that answers from a script and counts its calls; `inside` runs while a request is in flight. */
function scripted(outcomes: Outcome[], inside?: () => void) {
  const calls = { n: 0 };
  const action: AlertAction = {
    id: 'a',
    apiVersion: 1,
    async deliver(_payload, signal) {
      calls.n++;
      inside?.();
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
const run = (action: AlertAction, stopSignal?: AbortSignal) =>
  sendDue(db, [{ action, timeoutMs: 50 }], {
    now: () => now,
    ...(stopSignal ? { stopSignal } : {})
  });
const pendingCount = () =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE status = 'pending'").get() as {
      n: number;
    }
  ).n;

/** Puts the webhook into needs attention through a real permanent rejection of a first row. */
async function rejectOnce() {
  add();
  await run(scripted([permanent]).action);
}

describe('the needs-attention gate', () => {
  it('sets needs attention, the reason, the probe time and the degraded time on a permanent rejection', async () => {
    await rejectOnce();
    expect(getState(db, 'a')).toMatchObject({
      needsAttention: true,
      reason: 'HTTP 401',
      nextProbeAt: now + PROBE_INTERVAL_MS,
      degradedSince: now
    });
  });

  it('holds a row that arrives within 5 minutes of the last probe, and sends it after', async () => {
    await rejectOnce();
    add();
    const ok = scripted(['ok']);
    now += 60_000;
    expect(await run(ok.action)).toBe(0);
    expect(ok.calls.n).toBe(0);
    now += PROBE_INTERVAL_MS;
    expect(await run(ok.action)).toBe(1);
  });

  it('spaces attempts 5 minutes apart across repeated transport failures, and keeps the state', async () => {
    await rejectOnce();
    add();
    now += PROBE_INTERVAL_MS;
    let seenInside: number | null = null;
    const watched = scripted(
      [transport, transport, transport],
      () => (seenInside = getState(db, 'a').nextProbeAt)
    );
    await run(watched.action);
    expect(seenInside).toBe(now + PROBE_INTERVAL_MS); // written before the request went out
    for (let i = 0; i < 10; i++) {
      now += 10_000; // the row's own ladder allows a retry, the probe gate does not
      await run(watched.action);
    }
    expect(watched.calls.n).toBe(1);
    expect(getState(db, 'a')).toMatchObject({ needsAttention: true, reason: 'HTTP 401' });
    now += PROBE_INTERVAL_MS;
    await run(watched.action);
    expect(watched.calls.n).toBe(2);
  });

  it('keeps the gate after a shutdown cut an attempt short, so a restart cannot retry at once', async () => {
    await rejectOnce();
    add();
    now += PROBE_INTERVAL_MS;
    const stop = new AbortController();
    const pending = run(scripted(['hang']).action, stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    await pending;
    now += 10_000;
    const after = scripted(['ok']);
    expect(await run(after.action)).toBe(0);
    expect(after.calls.n).toBe(0);
  });

  it('clears needs attention on an HTTP answer that is not permanent, before any success', async () => {
    await rejectOnce();
    add();
    now += PROBE_INTERVAL_MS;
    await run(scripted([http503]).action);
    expect(getState(db, 'a')).toMatchObject({ needsAttention: false, reason: null });
    expect(getState(db, 'a').degradedSince).not.toBeNull();
  });

  it('clears needs attention on a success', async () => {
    await rejectOnce();
    add();
    now += PROBE_INTERVAL_MS;
    await run(scripted(['ok']).action);
    expect(getState(db, 'a').needsAttention).toBe(false);
  });

  it('attempts a row that arrives long after an idle queue went quiet at once', async () => {
    await rejectOnce();
    expect(pendingCount()).toBe(0);
    now += 10 * 60_000;
    add();
    const ok = scripted(['ok']);
    expect(await run(ok.action)).toBe(1);
  });
});

describe('the degraded flag', () => {
  it('is set by any failure, kept while rows are pending after a success, and cleared on an empty queue', async () => {
    add();
    add();
    await run(scripted([http503]).action);
    expect(getState(db, 'a').degradedSince).toBe(now);
    now += 5_000;
    await run(scripted(['ok']).action); // first row sent, second still pending
    expect(getState(db, 'a').degradedSince).toBe(1_000_000);
    expect(pendingCount()).toBe(1);
    await run(scripted(['ok']).action); // second row sent, queue empty
    expect(getState(db, 'a').degradedSince).toBeNull();
  });
});

describe('across a wall-clock jump', () => {
  it('moves the probe time and degraded time with the rows, forward and back', async () => {
    await rejectOnce();
    add();
    const before = getState(db, 'a');
    shiftPending(db, 3_600_000);
    expect(getState(db, 'a')).toMatchObject({
      degradedSince: before.degradedSince! + 3_600_000,
      nextProbeAt: before.nextProbeAt! + 3_600_000
    });
    shiftPending(db, -7_200_000);
    expect(getState(db, 'a').nextProbeAt).toBe(before.nextProbeAt! - 3_600_000);
  });

  it('pulls a probe time that is more than 5 minutes ahead back to 5 minutes', async () => {
    add();
    setNeedsAttention(db, 'a', 'HTTP 401', now + 3 * 3_600_000);
    const ok = scripted(['ok']);
    expect(await run(ok.action)).toBe(0);
    expect(getState(db, 'a').nextProbeAt).toBe(now + PROBE_INTERVAL_MS);
    now += PROBE_INTERVAL_MS;
    expect(await run(ok.action)).toBe(1);
  });
});
