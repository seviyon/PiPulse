import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import {
  AlertRulesError,
  CERTIFICATE_METRIC,
  builtinRules,
  evaluateCertificate,
  listAlerts,
  openAlerts,
  parseRuleEntry,
  ruleHash,
  ruleToEntry,
  startAlerts,
  type AlertContext,
  type AlertEvent,
  type Rule
} from '../src/index.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const T0 = 1_790_000_000_000;
const [expiring, expired] = builtinRules(4, { certificate: true }).filter(
  (r) => r.metric === CERTIFICATE_METRIC
) as [Rule, Rule];

describe('the certificate rules', () => {
  it('are built in only with HTTPS, warning before critical', () => {
    expect(builtinRules(4).some((r) => r.metric === CERTIFICATE_METRIC)).toBe(false);
    expect([expiring.id, expiring.certExpiresWithin, expiring.severity]).toEqual([
      'cert_expiring',
      14 * DAY,
      'warning'
    ]);
    expect([expired.id, expired.certExpired, expired.severity]).toEqual([
      'cert_expired',
      true,
      'critical'
    ]);
  });

  it('parse without metric, for or clearAfter, and round-trip to the file format', () => {
    const entry = parseRuleEntry(
      { id: 'cert_soon', certExpiresWithin: '30d', severity: 'warning', message: 'Soon' },
      'rule',
      'saved'
    );
    expect(entry.rule).toMatchObject({
      metric: CERTIFICATE_METRIC,
      certExpiresWithin: 30 * DAY,
      forMs: 0
    });
    expect(ruleToEntry(entry.rule!)).toEqual({
      id: 'cert_soon',
      certExpiresWithin: '30d',
      severity: 'warning',
      message: 'Soon'
    });
    for (const bad of [
      { certExpiresWithin: '0s' },
      { certExpiresWithin: 'forever' },
      { certExpiresWithin: '14d', metric: 'cpu_load' },
      { certExpiresWithin: '14d', for: '1min' },
      { certExpired: true, clearAfter: '1min' },
      { certExpired: false }
    ]) {
      expect(() =>
        parseRuleEntry({ id: 'x', severity: 'warning', message: 'm', ...bad }, 'rule', 'saved')
      ).toThrow(AlertRulesError);
    }
  });

  it('never change the hash of an existing rule', () => {
    const hot = builtinRules(4).find((r) => r.id === 'cpu_hot')!;
    expect(ruleHash(hot)).toBe('fedcc27a85458412');
    expect(ruleHash({ ...expiring, certExpiresWithin: 7 * DAY })).not.toBe(ruleHash(expiring));
  });
});

describe('evaluateCertificate (the spec table)', () => {
  const at = (notAfter: number, clockSynced = true) => ({ notAfter, clockSynced });
  it('is unavailable without a certificate, undecided on an unsynced clock (never a clear)', () => {
    expect(evaluateCertificate(expiring, undefined, T0, false)).toEqual({ action: 'unavailable' });
    expect(evaluateCertificate(expiring, at(T0 + DAY, false), T0, true)).toEqual({
      action: 'undecided'
    });
    expect(evaluateCertificate(expired, at(T0 - DAY, false), T0, false)).toEqual({
      action: 'undecided'
    });
  });
  it('has exact boundaries', () => {
    expect(evaluateCertificate(expiring, at(T0 + 14 * DAY), T0, false).action).toBe('raise');
    expect(evaluateCertificate(expiring, at(T0 + 14 * DAY + 1), T0, false).action).toBe('none');
    expect(evaluateCertificate(expiring, at(T0 + 14 * DAY - 1), T0, false).action).toBe('raise');
    expect(evaluateCertificate(expiring, at(T0 + 1), T0, false).action).toBe('raise');
    expect(evaluateCertificate(expiring, at(T0), T0, true).action).toBe('clear');
    expect(evaluateCertificate(expired, at(T0), T0, false).action).toBe('raise');
    expect(evaluateCertificate(expired, at(T0 + 1), T0, false).action).toBe('none');
    expect(evaluateCertificate(expired, at(T0 - 1), T0, true).action).toBe('none');
  });
  it('clears on a synced check once the condition no longer holds (renewal)', () => {
    expect(evaluateCertificate(expiring, at(T0 + 90 * DAY), T0, true)).toEqual({ action: 'clear' });
  });
});

describe('the engine with a certificate', () => {
  let db: PiPulseDb;
  let now: number;
  let events: AlertEvent[];
  let context: AlertContext;
  let engine: { check(): void; stop(): void } | undefined;
  let notices: string[];
  let mono: number;
  const start = (rules = [expiring, expired]) => {
    engine = startAlerts(db, {
      rules,
      metrics: [],
      now: () => now,
      monotonic: () => mono,
      context: () => context,
      onChange: (e) => events.push(e),
      onNotice: (message) => notices.push(message),
      intervalMs: 3_600_000
    });
  };
  beforeEach(() => {
    db = openDb(':memory:');
    now = T0;
    mono = 0;
    events = [];
    notices = [];
  });
  afterEach(() => {
    engine?.stop();
    db.close();
  });

  it('warns, then at expiry clears the warning before raising the critical, in one check', () => {
    context = { certificate: { notAfter: T0 + 10 * DAY, clockSynced: true } };
    start();
    expect(events.map((e) => `${e.type} ${e.alert.ruleId}`)).toEqual(['raised cert_expiring']);
    now = T0 + 10 * DAY;
    mono = 10 * DAY; // ten real days passed
    engine!.check();
    expect(events.map((e) => `${e.type} ${e.alert.ruleId}`)).toEqual([
      'raised cert_expiring',
      'cleared cert_expiring',
      'raised cert_expired'
    ]);
    expect(openAlerts(db).map((a) => a.ruleId)).toEqual(['cert_expired']);
    expect(openAlerts(db)[0]!.metric).toBe(CERTIFICATE_METRIC);
  });

  it('does not believe a clock that suddenly runs far ahead until it has stayed there', () => {
    context = { certificate: { notAfter: T0 + 10 * DAY, clockSynced: true } };
    start();
    expect(events.map((e) => e.alert.ruleId)).toEqual(['cert_expiring']);
    now = T0 + 11 * DAY; // a bad NTP answer: a day past expiry, though a minute went by
    mono = MINUTE;
    engine!.check();
    expect(events.map((e) => e.alert.ruleId)).toEqual(['cert_expiring']);
    now += 5 * MINUTE; // still wrong five minutes later
    mono += 5 * MINUTE;
    engine!.check();
    expect(openAlerts(db).map((a) => a.ruleId)).toEqual(['cert_expiring']);
    now = T0 + 6 * MINUTE; // NTP corrects itself: nothing was ever raised or retracted
    mono += MINUTE;
    engine!.check();
    expect(events.map((e) => e.alert.ruleId)).toEqual(['cert_expiring']);
    // a jump that stays is believed after 15 minutes
    now = T0 + 11 * DAY;
    mono += MINUTE;
    engine!.check();
    now += 16 * MINUTE;
    mono += 16 * MINUTE;
    engine!.check();
    expect(openAlerts(db).map((a) => a.ruleId)).toEqual(['cert_expired']);
  });

  it('freezes while the clock is unsynced, across a restart, then decides once synced', () => {
    context = { certificate: { notAfter: T0 + DAY, clockSynced: true } };
    start();
    engine!.stop();
    context = { certificate: { notAfter: T0 + 90 * DAY, clockSynced: false } }; // renewed, but the clock is unsure
    start();
    expect(openAlerts(db).map((a) => a.ruleId)).toEqual(['cert_expiring']);
    expect(notices).toEqual([
      'certificate alerts: waiting for a synchronized clock; open alerts stay open'
    ]);
    context = { certificate: { notAfter: T0 + 90 * DAY, clockSynced: true } };
    engine!.check();
    expect(openAlerts(db)).toEqual([]);
    expect(
      listAlerts(db, { state: 'all', from: 0, to: T0 + 365 * DAY, limit: 50 }).find(
        (a) => a.ruleId === 'cert_expiring'
      )?.clearedBy
    ).toBe('condition');
  });

  it('keeps an open alert when the certificate becomes unavailable', () => {
    context = { certificate: { notAfter: T0 - DAY, clockSynced: true } };
    start();
    context = {};
    engine!.check();
    expect(openAlerts(db).map((a) => a.ruleId)).toEqual(['cert_expired']);
    expect(notices).toEqual([
      'certificate alerts: no certificate information yet; nothing raised or cleared'
    ]);
  });

  it('closes certificate alerts as rule_removed when HTTPS goes off, and raises again when it is back', () => {
    context = { certificate: { notAfter: T0 - DAY, clockSynced: true } };
    start();
    engine!.stop();
    start([]); // HTTP: no certificate rules in force
    expect(openAlerts(db)).toEqual([]);
    engine!.stop();
    start();
    expect(openAlerts(db).map((a) => a.ruleId)).toEqual(['cert_expired']);
  });

  it('a new certificate never counts as a rule change; a new threshold does', () => {
    context = { certificate: { notAfter: T0 + DAY, clockSynced: true } };
    start();
    context = { certificate: { notAfter: T0 + 2 * DAY, clockSynced: true } };
    engine!.check();
    expect(events.filter((e) => e.type === 'cleared')).toEqual([]);
    engine!.stop();
    start([{ ...expiring, certExpiresWithin: 7 * DAY }, expired]);
    expect(events.find((e) => e.type === 'cleared')?.alert.clearedBy).toBe('rule_changed');
  });
});
