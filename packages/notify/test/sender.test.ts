import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { headOf, insertNotification, markSent, webhookStats } from '../src/outbox.js';
import {
  GIVE_UP_AFTER_MS,
  PRUNE_AFTER_MS,
  STOP_WAIT_MS,
  retryDelay,
  sendDue,
  startNotifications
} from '../src/sender.js';
import type { AlertAction } from '../src/action.js';

let db: PiPulseDb;
let now: number;
beforeEach(() => {
  db = openDb(':memory:');
  now = 1_000_000;
});
afterEach(() => db.close());

const add = (webhookId: string, event: 'raised' | 'cleared' = 'raised', at = now) =>
  insertNotification(db, {
    webhookId,
    alertId: 1,
    event,
    ruleId: 'r',
    metric: 'm',
    payload: `{"e":"${event}"}`,
    nextAt: at,
    createdAt: at
  });
const action = (
  id: string,
  results: (true | string | 'hang')[]
): AlertAction & { sent: string[] } => {
  const sent: string[] = [];
  return {
    id,
    apiVersion: 1,
    sent,
    async deliver(payload, signal) {
      const result = results.shift() ?? true;
      if (result === 'hang')
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('timeout')))
        );
      if (result !== true) throw new Error(result);
      sent.push(payload);
    }
  };
};
const run = (actions: AlertAction[], onGiveUp?: (id: string, n: number, reason: string) => void) =>
  sendDue(
    db,
    actions.map((a) => ({ action: a, timeoutMs: 50 })),
    { now: () => now, ...(onGiveUp ? { onGiveUp } : {}) }
  );

describe('sendDue', () => {
  it('backs off 5 s, 10 s, … up to 5 min', () => {
    expect([1, 2, 3, 7, 20].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 300_000, 300_000]);
  });

  it('sends in order per webhook: a later row waits behind a failing one', async () => {
    add('a');
    add('a', 'cleared');
    const a = action('a', ['HTTP 503', true, true]);
    expect(await run([a])).toBe(0);
    expect(headOf(db, 'a')).toMatchObject({
      event: 'raised',
      attempts: 1,
      nextAt: now + 5_000,
      lastError: 'HTTP 503'
    });
    expect(await run([a])).toBe(0); // not due yet
    now += 5_000;
    expect(await run([a])).toBe(1);
    expect(await run([a])).toBe(1);
    expect(a.sent).toEqual(['{"e":"raised"}', '{"e":"cleared"}']);
  });

  it('keeps webhooks independent, even when one hangs', async () => {
    add('slow');
    add('fast');
    const slow = action('slow', ['hang']);
    const fast = action('fast', [true]);
    expect(await run([slow, fast])).toBe(1);
    expect(fast.sent).toHaveLength(1);
    expect(headOf(db, 'slow')).toMatchObject({ attempts: 1, lastError: 'timeout' });
  });

  it('gives up after 6 hours with one callback', async () => {
    add('a');
    const giveUps: unknown[] = [];
    const a = action('a', Array(100).fill('HTTP 500'));
    now += GIVE_UP_AFTER_MS;
    await run([a], (...args) => giveUps.push(args));
    expect(giveUps).toEqual([['a', 1, 'HTTP 500']]);
    expect(headOf(db, 'a')).toBeUndefined();
    expect(webhookStats(db, 'a').lastFailure).toMatchObject({ reason: 'HTTP 500' });
  });

  it('pulls a far-future retry in to 5 minutes after the clock jumps back', async () => {
    add('a');
    const a = action('a', ['HTTP 500', true]);
    await run([a]); // next_at = now + 5 s
    now -= 3 * 60 * 60_000; // clock jumps back 3 h
    await run([a]); // next_at is > 5 min ahead: pulled to now + 5 min
    expect(headOf(db, 'a')!.nextAt).toBe(now + 5 * 60_000);
    now += 5 * 60_000;
    expect(await run([a])).toBe(1);
  });
});

describe('startNotifications', () => {
  it('fails rows of removed webhooks at start and reports status without the URL', async () => {
    add('gone');
    const n = startNotifications(db, {
      webhooks: [
        {
          id: 'apprise',
          url: 'https://u:p@apprise.lan:8000/notify/key?x=1',
          method: 'POST',
          headers: { A: 'b' },
          events: ['raised'],
          minSeverity: 'critical',
          timeoutMs: 1000
        }
      ],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      intervalMs: 1e9,
      actions: [action('apprise', [])]
    });
    expect(webhookStats(db, 'gone').lastFailure).toMatchObject({ reason: 'webhook removed' });
    const status = n.status();
    expect(status).toEqual([
      {
        id: 'apprise',
        host: 'apprise.lan:8000',
        method: 'POST',
        events: ['raised'],
        minSeverity: 'critical',
        pending: 0,
        lastSuccessAt: null,
        lastFailure: null
      }
    ]);
    expect(JSON.stringify(status)).not.toMatch(/notify\/key|u:p|x=1/);
    await n.stop();
  });

  it("delivers a healthy webhook's backlog while another hangs until its timeout", async () => {
    const webhook = (id: string) => ({
      id,
      url: 'http://x',
      method: 'POST' as const,
      headers: {},
      events: ['raised' as const, 'cleared' as const],
      minSeverity: 'warning' as const,
      timeoutMs: 2000
    });
    add('slow');
    add('fast');
    add('fast', 'cleared');
    add('fast');
    const slow = action('slow', ['hang', 'hang']);
    const fast = action('fast', [true, true, true]);
    const n = startNotifications(db, {
      webhooks: [webhook('slow'), webhook('fast')],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      intervalMs: 1e9,
      actions: [slow, fast]
    });
    await vi.waitFor(() => expect(fast.sent).toHaveLength(3), { timeout: 500 });
    await n.stop();
  });

  describe('across a clock jump', () => {
    const HOUR = 60 * 60_000;
    let mono: number;
    const logs: string[] = [];
    const startFailing = () => {
      mono = 0;
      logs.length = 0;
      add('a');
      return startNotifications(db, {
        webhooks: [
          {
            id: 'a',
            url: 'http://x',
            method: 'POST',
            headers: {},
            events: ['raised', 'cleared'],
            minSeverity: 'warning',
            timeoutMs: 1000
          }
        ],
        hostname: 'Io',
        metrics: [],
        now: () => now,
        monotonic: () => mono,
        log: (message) => logs.push(message),
        intervalMs: 10,
        actions: [action('a', Array(10).fill('HTTP 500'))]
      });
    };

    it('keeps retrying after the clock jumps forward (NTP after boot)', async () => {
      const t0 = now;
      const n = startFailing();
      await vi.waitFor(() => expect(headOf(db, 'a')!.attempts).toBe(1));
      mono += 5_000;
      now += 10 * HOUR + 5_000;
      await vi.waitFor(() => expect(headOf(db, 'a')?.attempts).toBe(2));
      expect(headOf(db, 'a')!.createdAt).toBe(t0 + 10 * HOUR);
      expect(logs.join('\n')).toMatch(/clock jumped forward/);
      await n.stop();
    });

    it('still gives up after 6 hours when the clock jumped back meanwhile', async () => {
      const n = startFailing();
      await vi.waitFor(() => expect(headOf(db, 'a')!.attempts).toBe(1));
      mono += 6 * HOUR + 1_000;
      now += 3 * HOUR + 1_000;
      await vi.waitFor(() => expect(headOf(db, 'a')).toBeUndefined());
      expect(webhookStats(db, 'a').lastFailure).toMatchObject({ reason: 'HTTP 500' });
      expect(logs.join('\n')).toMatch(/clock jumped back/);
      await n.stop();
    });
  });

  it('stops within 5 s, leaving an interrupted delivery pending and uncounted', async () => {
    add('a');
    const hang = action('a', ['hang']);
    const n = startNotifications(db, {
      webhooks: [
        {
          id: 'a',
          url: 'http://x',
          method: 'POST',
          headers: {},
          events: ['raised', 'cleared'],
          minSeverity: 'warning',
          timeoutMs: 60_000
        }
      ],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      intervalMs: 1e9,
      actions: [hang]
    });
    await new Promise((resolve) => setTimeout(resolve, 20)); // delivery in flight
    const started = performance.now();
    await n.stop();
    expect(performance.now() - started).toBeLessThan(STOP_WAIT_MS);
    expect(headOf(db, 'a')).toMatchObject({ attempts: 0, lastError: null });
  });

  it('wakes on enqueue and delivers', async () => {
    const a = action('apprise', [true]);
    const n = startNotifications(db, {
      webhooks: [
        {
          id: 'apprise',
          url: 'http://x',
          method: 'POST',
          headers: {},
          events: ['raised', 'cleared'],
          minSeverity: 'warning',
          timeoutMs: 1000
        }
      ],
      hostname: 'Io',
      metrics: [],
      intervalMs: 1e9,
      actions: [a]
    });
    const { raiseAlert } = await import('@pipulse/alerts');
    n.enqueue({
      type: 'raised',
      alert: raiseAlert(db, {
        ruleId: 'r',
        metric: 'm',
        severity: 'warning',
        message: 'M',
        value: 1,
        raisedAt: Date.now()
      })
    });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    await n.stop();
  });
  it('prunes rows sent more than 7 days ago on its first run', async () => {
    add('a');
    markSent(db, headOf(db, 'a')!.id, now);
    add('a', 'cleared', now + PRUNE_AFTER_MS);
    markSent(db, headOf(db, 'a')!.id, now + PRUNE_AFTER_MS);
    now += PRUNE_AFTER_MS + 24 * 60 * 60_000;
    const n = startNotifications(db, {
      webhooks: [
        {
          id: 'a',
          url: 'http://x',
          method: 'POST',
          headers: {},
          events: ['raised', 'cleared'],
          minSeverity: 'warning',
          timeoutMs: 1000
        }
      ],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      intervalMs: 1e9,
      actions: [action('a', [])]
    });
    await n.stop();
    const rows = db.prepare('SELECT event FROM notifications').all();
    expect(rows).toEqual([{ event: 'cleared' }]);
  });
});

/** The database, but a statement matching `pattern` throws while `armed.on` is set. */
function breaking(pattern: RegExp) {
  const armed = { on: false };
  const proxy = {
    prepare(sql: string) {
      if (armed.on && pattern.test(sql)) throw new Error('disk I/O error');
      return db.prepare(sql);
    }
  } as unknown as PiPulseDb;
  return { db: proxy, armed };
}
const hook = (id: string, timeoutMs = 1000) => ({
  id,
  url: 'http://127.0.0.1:1/x',
  method: 'POST' as const,
  headers: {},
  events: ['raised' as const, 'cleared' as const],
  minSeverity: 'warning' as const,
  timeoutMs
});

describe('delivery that fails in odd ways', () => {
  it('records the text of a failure that is not an Error', async () => {
    add('a');
    const odd: AlertAction = {
      id: 'a',
      apiVersion: 1,
      deliver: () => Promise.reject('plain string')
    };
    expect(await run([odd])).toBe(0);
    expect(headOf(db, 'a')).toMatchObject({ attempts: 1, lastError: 'plain string' });
  });

  it('survives its row disappearing during the attempt', async () => {
    add('a');
    const vanishing: AlertAction = {
      id: 'a',
      apiVersion: 1,
      deliver: async () => {
        db.exec('DELETE FROM notifications');
        throw new Error('HTTP 500');
      }
    };
    expect(await run([vanishing])).toBe(0);
    expect(headOf(db, 'a')).toBeUndefined();
  });
});

describe('startNotifications, problems it logs instead of throwing', () => {
  it('with no webhooks: still prunes old rows, reports nothing, and stops at once', async () => {
    add('old');
    markSent(db, headOf(db, 'old')!.id, now);
    now += PRUNE_AFTER_MS + 1000;
    const n = startNotifications(db, { webhooks: [], hostname: 'Io', metrics: [], now: () => now });
    expect(n.status()).toEqual([]);
    n.enqueue({} as never); // nothing to deliver: ignored
    await n.stop();
    expect(db.prepare('SELECT count(*) AS n FROM notifications').get()).toEqual({ n: 0 });
  });

  it('logs a failed prune, with the default logger when none is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { db: flaky, armed } = breaking(/DELETE FROM notifications/);
      armed.on = true;
      const n = startNotifications(flaky, { webhooks: [], hostname: 'Io', metrics: [] });
      await n.stop();
      expect(warn).toHaveBeenCalledWith('[pipulse] notification pruning failed: disk I/O error');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a failed clock adjustment and keeps running', async () => {
    const { db: flaky, armed } = breaking(/SET created_at = created_at \+/);
    const logs: string[] = [];
    const mono = 0;
    const n = startNotifications(flaky, {
      webhooks: [hook('a')],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      monotonic: () => mono,
      log: (m) => logs.push(m),
      intervalMs: 5,
      actions: [action('a', [])]
    });
    armed.on = true;
    now += 10 * 60 * 60_000; // the wall clock jumps, monotonic time does not
    await vi.waitFor(() =>
      expect(logs).toContain('notification clock adjustment failed: disk I/O error')
    );
    await n.stop();
  });

  it('words a clock jump over several queued rows in the plural', async () => {
    add('a');
    add('a', 'cleared');
    const logs: string[] = [];
    const mono = 0;
    const n = startNotifications(db, {
      webhooks: [hook('a')],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      monotonic: () => mono,
      log: (m) => logs.push(m),
      intervalMs: 5,
      actions: [action('a', ['HTTP 500'])]
    });
    await vi.waitFor(() => expect(headOf(db, 'a')!.attempts).toBe(1));
    now += 60 * 60_000;
    await vi.waitFor(() =>
      expect(logs.join('\n')).toMatch(
        /clock jumped forward 3600 s; moved 2 queued notifications with it/
      )
    );
    await n.stop();
  });

  it('logs a delivery loop that throws, and keeps its timer', async () => {
    const { db: flaky, armed } = breaking(/SELECT[\s\S]*FROM notifications/);
    const logs: string[] = [];
    const n = startNotifications(flaky, {
      webhooks: [hook('a')],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      log: (m) => logs.push(m),
      intervalMs: 5,
      actions: [action('a', [])]
    });
    armed.on = true;
    await vi.waitFor(() => expect(logs).toContain('notification delivery failed: disk I/O error'));
    await n.stop();
  });

  it('logs an event it cannot queue, without throwing into the engine', async () => {
    const { db: flaky, armed } = breaking(/INSERT INTO notifications/);
    const logs: string[] = [];
    const n = startNotifications(flaky, {
      webhooks: [hook('a')],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      log: (m) => logs.push(m),
      intervalMs: 1e9,
      actions: [action('a', [])]
    });
    const { raiseAlert } = await import('@pipulse/alerts');
    const alert = raiseAlert(db, {
      ruleId: 'r',
      metric: 'm',
      severity: 'warning',
      message: 'M',
      value: 1,
      raisedAt: now
    });
    armed.on = true;
    expect(() => n.enqueue({ type: 'raised', alert })).not.toThrow();
    expect(logs).toContain('notification queueing failed: disk I/O error');
    await n.stop();
  });
});

describe('startNotifications, wakes while a delivery is in flight', () => {
  it('runs another pass after a failed delivery that a wake arrived during', async () => {
    add('a');
    let release!: () => void;
    let calls = 0;
    const slow: AlertAction = {
      id: 'a',
      apiVersion: 1,
      deliver: () => {
        calls++;
        return new Promise<void>((_, reject) => {
          release = () => reject(new Error('HTTP 500'));
        });
      }
    };
    const n = startNotifications(db, {
      webhooks: [hook('a')],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      intervalMs: 5,
      actions: [slow]
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 40)); // several timer wakes land while busy
    release();
    await vi.waitFor(() => expect(headOf(db, 'a')!.attempts).toBe(1));
    expect(calls).toBe(1); // the retry is not due yet: the extra pass sent nothing
    await n.stop();
  });

  it('builds the webhook action itself when none is supplied', async () => {
    const n = startNotifications(db, {
      webhooks: [hook('a')],
      hostname: 'Io',
      metrics: [],
      intervalMs: 1e9
    });
    expect(n.status()).toHaveLength(1);
    await n.stop();
  });
});
