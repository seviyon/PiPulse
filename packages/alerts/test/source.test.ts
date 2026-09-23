import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSettings, openDb, saveSettings, type PiPulseDb } from '@pipulse/storage';
import {
  AlertRulesError,
  createRuleSource,
  MAX_SAVED_RULES,
  SAVED_RULES_KEY
} from '../src/index.js';

const MIN = 60_000;
const DAY = 86_400_000;
const metrics = [
  'cpu_load',
  'load_1',
  'cpu_temperature',
  'throttled',
  'swap_used',
  'swap_io',
  'disk_used',
  'boot_used'
].map((id) => ({ id, intervalMs: 10_000 }));
const busy = {
  id: 'test_busy',
  metric: 'cpu_load',
  atLeast: 50,
  for: '1min',
  severity: 'warning',
  message: 'Busy'
};

let db: PiPulseDb;
let raw: { ms: number; text: string };
let problems: string[];
beforeEach(() => {
  db = openDb(':memory:');
  raw = { ms: 2 * DAY, text: '2d' };
  problems = [];
});
afterEach(() => db.close());

const source = (file?: object) =>
  createRuleSource(db, {
    cores: 4,
    metrics,
    rawRetention: () => raw,
    onProblem: (message) => problems.push(message),
    ...(file ? { file: { name: 'alerts.json', text: JSON.stringify(file) } } : {})
  });
const ids = (rules: { id: string }[]) => rules.map((rule) => rule.id);

describe('createRuleSource', () => {
  it('lists built-ins and file rules with their kind when nothing is saved', () => {
    const { rules, entries } = source({ rules: [{ ...busy, id: 'from_file' }] }).read();
    expect(ids(rules)).toContain('cpu_busy');
    expect(entries.find((e) => e.id === 'cpu_busy')).toMatchObject({
      kind: 'built-in',
      saved: false,
      disabled: false,
      problem: null,
      written: { id: 'cpu_busy', atLeast: 90, for: '15min' }
    });
    expect(entries.find((e) => e.id === 'from_file')).toMatchObject({ kind: 'file' });
  });

  it('adds, edits, disables and reverts through save and remove, read live', () => {
    const s = source();
    expect(s.save(busy)).toEqual({ ok: true });
    expect(s.save({ ...busy, id: 'cpu_hot', atLeast: 75, severity: 'critical' })).toEqual({
      ok: true
    });
    expect(s.save({ id: 'cpu_busy', disabled: true })).toEqual({ ok: true });

    const { rules, entries } = s.read();
    expect(ids(rules)).toContain('test_busy');
    expect(ids(rules)).not.toContain('cpu_busy');
    expect(rules.find((r) => r.id === 'cpu_hot')).toMatchObject({ atLeast: 75, source: 'saved' });
    expect(entries.find((e) => e.id === 'test_busy')).toMatchObject({ kind: 'added', saved: true });
    expect(entries.find((e) => e.id === 'cpu_hot')).toMatchObject({
      kind: 'edited',
      overrides: { atLeast: 80, source: 'built-in' }
    });
    expect(entries.find((e) => e.id === 'cpu_busy')).toMatchObject({
      kind: 'built-in',
      disabled: true,
      saved: true,
      written: { id: 'cpu_busy', atLeast: 90 }
    });

    expect(s.remove('cpu_hot')).toBe(true);
    expect(s.remove('cpu_busy')).toBe(true);
    expect(s.remove('cpu_busy')).toBe(false);
    const after = s.read();
    expect(after.rules.find((r) => r.id === 'cpu_hot')).toMatchObject({ atLeast: 80 });
    expect(ids(after.rules)).toContain('cpu_busy');
  });

  it('keeps an added rule that is switched off, and replaces an entry in place', () => {
    const s = source();
    s.save(busy);
    s.save({ ...busy, disabled: true });
    expect(ids(s.read().rules)).not.toContain('test_busy');
    expect(s.read().entries.find((e) => e.id === 'test_busy')).toMatchObject({
      kind: 'added',
      disabled: true,
      rule: { atLeast: 50 }
    });
    expect(getSettings(db)[SAVED_RULES_KEY]).toHaveLength(1);
  });

  it('answers field errors instead of saving an invalid entry', () => {
    const s = source();
    expect(s.save({ ...busy, severity: 'loud' })).toEqual({
      ok: false,
      errors: { severity: 'severity must be warning or critical' }
    });
    expect(s.save({ ...busy, metric: 'nope' })).toMatchObject({
      ok: false,
      errors: { metric: expect.stringContaining('unknown metric') }
    });
    expect(s.save({ ...busy, for: '3d' })).toEqual({
      ok: false,
      errors: { for: 'longer than raw retention (2d); raise it on the Settings page first' }
    });
    expect(s.save({ id: 'not_a_rule', disabled: true })).toMatchObject({
      ok: false,
      errors: { id: expect.any(String) }
    });
    expect(getSettings(db)[SAVED_RULES_KEY]).toBeUndefined();
  });

  it('refuses more than the saved-rule cap', () => {
    const s = source();
    saveSettings(db, {
      [SAVED_RULES_KEY]: Array.from({ length: MAX_SAVED_RULES }, (_, i) => ({
        ...busy,
        id: `r${i}`
      }))
    });
    expect(s.save({ ...busy, id: 'one_more' })).toMatchObject({
      ok: false,
      errors: { id: expect.any(String) }
    });
    expect(s.save({ ...busy, id: 'r0', atLeast: 60 })).toEqual({ ok: true });
  });

  it('skips a saved entry that became invalid, keeps the rule below, and reports it once', () => {
    const s = source();
    s.save({ ...busy, id: 'cpu_hot', for: '1d' });
    raw = { ms: 12 * 60 * MIN, text: '12h' };
    const first = s.read();
    s.read();
    expect(first.rules.find((r) => r.id === 'cpu_hot')).toMatchObject({ source: 'built-in' });
    expect(first.entries.find((e) => e.id === 'cpu_hot')).toMatchObject({
      kind: 'edited',
      problem: 'longer than raw retention (12h); raise it on the Settings page first',
      written: { for: '1d' }
    });
    expect(problems).toEqual([
      'saved alert rule "cpu_hot" is not in force: longer than raw retention (12h); raise it on the Settings page first'
    ]);
  });

  it('shows a corrupt saved row as a problem instead of throwing', () => {
    saveSettings(db, { [SAVED_RULES_KEY]: [{ id: 'weird', metric: 5 }, 'nonsense'] });
    const { entries } = source().read();
    expect(entries.find((e) => e.id === 'weird')).toMatchObject({
      kind: 'added',
      problem: expect.any(String),
      rule: null
    });
  });

  it('still refuses a bad rules file at creation', () => {
    expect(() => source({ rules: [{ id: 'x' }] })).toThrow(AlertRulesError);
  });
});
