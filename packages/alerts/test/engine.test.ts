import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertSample, openDb, type PiPulseDb } from '@pipulse/storage';
import { openAlerts, raiseAlert, startAlerts, type AlertEvent, type Rule } from '../src/index.js';

const MIN = 60_000;
const T0 = 1_790_000_000_000;
const metrics = [
  { id: 'cpu_temperature', intervalMs: 10_000 },
  { id: 'disk_used', intervalMs: 60_000 }
];
const hot: Rule = {
  id: 'cpu_hot',
  metric: 'cpu_temperature',
  atLeast: 80,
  forMs: 2 * MIN,
  clearAfterMs: 2 * MIN,
  severity: 'critical',
  message: 'CPU running hot',
  source: 'built-in'
};
const silent: Rule = {
  id: 'not_collecting',
  metric: '*',
  noReadingFor: 'auto',
  forMs: 0,
  clearAfterMs: 0,
  severity: 'warning',
  message: 'No new readings',
  source: 'built-in'
};

let db: PiPulseDb;
let now: number;
let events: AlertEvent[];
let engines: { stop(): void }[];

beforeEach(() => {
  db = openDb(':memory:');
  now = T0;
  events = [];
  engines = [];
});
afterEach(() => {
  engines.forEach((engine) => engine.stop());
  db.close();
});

/** Checks run only when a test calls check(); the interval matters for clock-jump detection. */
function start(rules: Rule[], onError?: (error: unknown, rule?: Rule) => void, intervalMs = 1e9) {
  const engine = startAlerts(db, {
    rules,
    metrics,
    intervalMs,
    now: () => now,
    onChange: (event) => events.push(event),
    ...(onError ? { onError } : {})
  });
  engines.push(engine);
  return engine;
}

/** Readings of `metric` every `step` ms over [from, to]. */
function readings(metric: string, from: number, to: number, value: number, step = 10_000) {
  for (let ts = from; ts <= to; ts += step) insertSample(db, { ts, metric, value });
}

describe('startAlerts', () => {
  it('raises after `for`, keeps one open alert across checks and restarts, then clears', () => {
    readings('cpu_temperature', T0 - 3 * MIN, T0, 85);
    const engine = start([hot]);
    expect(events).toMatchObject([
      { type: 'raised', alert: { ruleId: 'cpu_hot', value: 85, raisedAt: T0 } }
    ]);

    now = T0 + 15_000;
    readings('cpu_temperature', T0 + 10_000, now, 85);
    engine.check();
    start([hot]); // a restart: a second engine on the same database
    expect(openAlerts(db)).toHaveLength(1);
    expect(events).toHaveLength(1);

    now = T0 + 5 * MIN;
    readings('cpu_temperature', T0 + 20_000, now, 60);
    engine.check();
    expect(events.at(-1)).toMatchObject({
      type: 'cleared',
      alert: { clearedBy: 'condition', clearedAt: now }
    });
    expect(openAlerts(db)).toHaveLength(0);
  });

  it('raises a "*" silence rule once per silent metric', () => {
    readings('cpu_temperature', T0 - 10 * MIN, T0 - 5 * MIN, 50);
    readings('disk_used', T0 - 20 * MIN, T0 - 10 * MIN, 40, 60_000);
    start([silent]);
    expect(events).toHaveLength(0); // silence counts from engine start at the earliest
    now = T0 + 10 * MIN;
    engines[0]!.check();
    expect(
      openAlerts(db)
        .map((a) => a.metric)
        .sort()
    ).toEqual(['cpu_temperature', 'disk_used']);
  });

  it('does not flash a silence alert when the clock jumps forward (NTP after boot)', () => {
    readings('cpu_temperature', T0 - MIN, T0, 50);
    const engine = start([silent], undefined, 15_000);
    now = T0 + 6 * 3_600_000; // the clock jumps six hours between two 15 s checks
    engine.check();
    expect(events).toHaveLength(0);
  });

  it('closes open alerts whose rule is gone, including a built-in id reused for another metric', () => {
    const removed = raiseAlert(db, {
      ruleId: 'gone',
      metric: 'disk_used',
      severity: 'warning',
      message: 'm',
      value: 1,
      raisedAt: T0 - MIN
    });
    const moved = raiseAlert(db, {
      ruleId: 'cpu_hot',
      metric: 'cpu_temperature',
      severity: 'critical',
      message: 'm',
      value: 90,
      raisedAt: T0 - MIN
    });
    start([{ ...hot, metric: 'disk_used' }]);
    const closed = events.map((e) => [e.type, e.alert.id, e.alert.clearedBy]);
    expect(closed).toHaveLength(2);
    expect(closed).toEqual(
      expect.arrayContaining([
        ['cleared', removed.id, 'rule_removed'],
        ['cleared', moved.id, 'rule_removed']
      ])
    );
    expect(openAlerts(db)).toHaveLength(0);
  });

  it('reports a failing rule and still checks the others', () => {
    readings('cpu_temperature', T0 - 3 * MIN, T0, 85);
    const errors: string[] = [];
    const broken: Rule = {
      ...hot,
      id: 'broken',
      get atLeast(): number {
        throw new Error('boom');
      }
    };
    start([broken, hot], (error, rule) => {
      if (rule) errors.push(rule.id);
    });
    expect(errors).toEqual(['broken']);
    expect(events).toMatchObject([{ type: 'raised', alert: { ruleId: 'cpu_hot' } }]);
  });

  it('keeps checking when a listener throws', () => {
    readings('cpu_temperature', T0 - 3 * MIN, T0, 85);
    startAlerts(db, {
      rules: [hot],
      metrics,
      intervalMs: 1e9,
      now: () => now,
      onChange: () => {
        throw new Error('socket gone');
      }
    }).stop();
    expect(openAlerts(db)).toHaveLength(1);
  });

  it('reports a failed open-alerts read and still checks after recovery', () => {
    readings('cpu_temperature', T0 - 3 * MIN, T0, 85);
    const errors: Array<{ error: unknown; rule?: Rule }> = [];
    const engine = start([hot], (error, rule) => {
      errors.push({ error, rule });
    });
    expect(events).toHaveLength(1); // initially raised

    // Break the alerts table
    db.exec('ALTER TABLE alerts RENAME TO alerts_away');

    // check() should not throw, should report error with no rule
    engine.check();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.rule).toBeUndefined();
    expect(events).toHaveLength(1); // no new events from failed check

    // Restore the table
    db.exec('ALTER TABLE alerts_away RENAME TO alerts');

    // check() should work again; add a breach to verify
    now = T0 + 5 * MIN;
    readings('cpu_temperature', T0 + 10_000, now, 60);
    engine.check();
    expect(events).toHaveLength(2); // raised + cleared
    expect(events[1]).toMatchObject({
      type: 'cleared',
      alert: { clearedBy: 'condition', clearedAt: now }
    });
    expect(errors).toHaveLength(1); // no new errors on recovery
  });
});
