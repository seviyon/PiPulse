import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { clearAlert, raiseAlert, type AlertEvent } from '@pipulse/alerts';
import { createEnqueuer, CHANGED_CLEAR_DELAY_MS } from '../src/enqueue.js';
import type { WebhookConfig } from '../src/config.js';

const T = 1_790_000_000_000;
let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const hook = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  id: 'all',
  url: 'http://x',
  method: 'POST',
  headers: {},
  events: ['raised', 'cleared'],
  minSeverity: 'warning',
  timeoutMs: 1000,
  ...over
});
const rows = () =>
  db
    .prepare(
      'SELECT webhook_id AS w, event, next_at AS nextAt, payload FROM notifications ORDER BY id'
    )
    .all() as { w: string; event: string; nextAt: number; payload: string }[];
const base = {
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  severity: 'critical' as const,
  message: 'CPU running hot',
  value: 82
};
const enqueuer = (webhooks: WebhookConfig[]) =>
  createEnqueuer(db, {
    webhooks,
    hostname: 'Io',
    metrics: [{ id: 'cpu_temperature', label: 'CPU temperature', unit: '°C' }],
    now: () => T
  });
const raised = (over = {}): AlertEvent => ({
  type: 'raised',
  alert: raiseAlert(db, { ...base, raisedAt: T, ...over })
});

describe('createEnqueuer', () => {
  it('queues a raise and a condition clear for every matching webhook, due now', () => {
    const enqueue = enqueuer([
      hook(),
      hook({ id: 'crit', minSeverity: 'critical' }),
      hook({ id: 'raises', events: ['raised'] })
    ]);
    const r = raised({ severity: 'warning' });
    enqueue(r);
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 1000, 'condition') });
    expect(rows().map((x) => [x.w, x.event, x.nextAt])).toEqual([
      ['all', 'raised', T],
      ['raises', 'raised', T],
      ['all', 'cleared', T]
    ]);
    expect(JSON.parse(rows()[0]!.payload)).toMatchObject({ type: 'warning' });
  });

  it('sends nothing for rule_removed clears', () => {
    const enqueue = enqueuer([hook()]);
    const r = raised();
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T, 'rule_removed') });
    expect(rows().map((x) => x.event)).toEqual([]);
  });

  it("drops an edit's close and reopen when severity and message are unchanged", () => {
    const enqueue = enqueuer([hook()]);
    const r = raised();
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    expect(rows()).toEqual([
      expect.objectContaining({ event: 'cleared', nextAt: T + CHANGED_CLEAR_DELAY_MS })
    ]);
    enqueue(raised({ raisedAt: T + 5000 }));
    expect(rows()).toEqual([]);
  });

  it('announces the reopen when severity or message changed', () => {
    const enqueue = enqueuer([hook()]);
    const r = raised({ severity: 'warning' });
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    enqueue(raised({ raisedAt: T + 5000 }));
    expect(rows().map((x) => x.event)).toEqual(['raised']);
  });

  it('still sends the clear to a webhook the edited, lower-severity alert no longer reaches', () => {
    const enqueue = enqueuer([hook(), hook({ id: 'crit', minSeverity: 'critical' })]);
    const r = raised(); // critical: both webhooks hear it
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    enqueue(raised({ raisedAt: T + 5000, severity: 'warning' }));
    expect(rows().map(({ w, event }) => `${w} ${event}`)).toEqual(['crit cleared', 'all raised']);
  });

  it('pairs from the closed alert even for a webhook that only listens to raises', () => {
    const enqueue = enqueuer([hook({ events: ['raised'] })]);
    const r = raised();
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    enqueue(raised({ raisedAt: T + 5000 }));
    expect(rows()).toEqual([]);
  });

  it('keeps the delayed clear when nothing reopens, and reports errors instead of throwing', () => {
    const errors: unknown[] = [];
    const enqueue = createEnqueuer(db, {
      webhooks: [hook()],
      hostname: 'Io',
      metrics: [],
      now: () => T,
      onError: (e) => errors.push(e)
    });
    const r = raised();
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    expect(rows().map((x) => x.event)).toEqual(['cleared']);
    db.exec('DROP TABLE notifications');
    expect(() => enqueue(raised({ metric: 'other' }))).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
