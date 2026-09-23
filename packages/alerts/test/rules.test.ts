import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlertRulesError, builtinRules, readRulesFile, resolveRules } from '../src/index.js';

const MIN = 60_000;
const DAY = 86_400_000;
const metrics = [
  'cpu_load',
  'load_1',
  'cpu_temperature',
  'throttled',
  'swap_used',
  'disk_used',
  'boot_used'
].map((id) => ({ id, intervalMs: 10_000 }));
const base = { cores: 4, metrics, rawRetentionMs: 2 * DAY };
const withFile = (rules: unknown) => ({
  ...base,
  file: { name: 'alerts.json', text: JSON.stringify({ rules }) }
});

describe('builtinRules', () => {
  it('ships the agreed defaults', () => {
    const byId = new Map(builtinRules(4).map((rule) => [rule.id, rule]));
    expect(byId.get('cpu_warm')).toMatchObject({
      atLeast: 70,
      forMs: 10 * MIN,
      severity: 'warning'
    });
    expect(byId.get('cpu_hot')).toMatchObject({
      atLeast: 80,
      forMs: 2 * MIN,
      severity: 'critical'
    });
    expect(byId.get('disk_filling')).toMatchObject({ atLeast: 70, severity: 'warning' });
    expect(byId.get('disk_full')).toMatchObject({ atLeast: 90, severity: 'critical' });
    expect(byId.get('throttled_now')).toMatchObject({ bitsSet: 0xf, forMs: MIN });
    expect(byId.get('throttled_before')).toMatchObject({ bitsSet: 0xf0000, forMs: 0 });
    expect(byId.get('load_queueing')).toMatchObject({
      metric: 'load_1',
      atLeast: 4,
      forMs: 15 * MIN
    });
    expect(byId.get('not_collecting')).toMatchObject({ metric: '*', noReadingFor: 'auto' });
    for (const rule of byId.values()) {
      expect(rule.source).toBe('built-in');
      if (rule.noReadingFor === undefined) expect(rule.clearAfterMs).toBe(rule.forMs);
    }
  });

  it('puts the load threshold at the detected core count', () => {
    expect(builtinRules(8).find((rule) => rule.id === 'load_queueing')?.atLeast).toBe(8);
  });
});

describe('resolveRules', () => {
  it('returns the built-ins when there is no file', () => {
    expect(resolveRules(base)).toEqual(builtinRules(4));
  });

  it('adds, replaces and disables rules from the file by id', () => {
    const rules = resolveRules(
      withFile([
        {
          id: 'cpu_warm',
          metric: 'cpu_temperature',
          atLeast: 65,
          for: '5min',
          severity: 'warning',
          message: 'Warm'
        },
        { id: 'cpu_busy', disabled: true },
        {
          id: 'swap_any',
          metric: 'swap_used',
          atLeast: 1,
          severity: 'warning',
          message: 'Swapping',
          clearAfter: '30s'
        }
      ])
    );
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    expect(byId.get('cpu_warm')).toMatchObject({
      atLeast: 65,
      forMs: 5 * MIN,
      clearAfterMs: 5 * MIN,
      source: 'file'
    });
    expect(byId.has('cpu_busy')).toBe(false);
    expect(byId.get('swap_any')).toMatchObject({ forMs: 0, clearAfterMs: 30_000, source: 'file' });
  });

  it.each([
    [
      [{ id: 'x', metric: 'nope', atLeast: 1, severity: 'warning', message: 'm' }],
      /unknown metric "nope"/
    ],
    [[{ id: 'x', metric: 'cpu_load', severity: 'warning', message: 'm' }], /exactly one of/],
    [
      [{ id: 'x', metric: 'cpu_load', atLeast: 1, atMost: 2, severity: 'warning', message: 'm' }],
      /exactly one of/
    ],
    [
      [{ id: 'x', metric: 'cpu_load', atLeast: 1, for: '3d', severity: 'warning', message: 'm' }],
      /for is longer than raw retention/
    ],
    [
      [
        {
          id: 'x',
          metric: 'cpu_load',
          noReadingFor: '1min',
          for: '1min',
          severity: 'warning',
          message: 'm'
        }
      ],
      /for is not allowed with noReadingFor/
    ],
    [
      [
        {
          id: 'x',
          metric: 'cpu_load',
          noReadingFor: '1min',
          clearAfter: '1min',
          severity: 'warning',
          message: 'm'
        }
      ],
      /clearAfter is not allowed with noReadingFor/
    ],
    [
      [{ id: 'x', metric: '*', atLeast: 1, severity: 'warning', message: 'm' }],
      /"\*" is only allowed with noReadingFor/
    ],
    [
      [{ id: 'x', metric: 'cpu_load', atLeast: 1, for: '5m', severity: 'warning', message: 'm' }],
      /for must be a duration/
    ],
    [
      [{ id: 'x', metric: 'cpu_load', atLeast: 1, severity: 'loud', message: 'm' }],
      /severity must be warning or critical/
    ],
    [
      [
        {
          id: 'x',
          metric: 'cpu_load',
          atLeast: 1,
          severity: 'warning',
          message: 'm',
          colour: 'red'
        }
      ],
      /unknown field "colour"/
    ],
    [
      [{ id: 'Bad-Id', metric: 'cpu_load', atLeast: 1, severity: 'warning', message: 'm' }],
      /lowercase snake_case/
    ],
    [
      [{ id: 'x', metric: 'throttled', bitsSet: 1.5, severity: 'warning', message: 'm' }],
      /bitsSet must be a positive integer/
    ],
    [
      [
        { id: 'x', metric: 'cpu_load', atLeast: 1, severity: 'warning', message: 'm' },
        { id: 'x', metric: 'cpu_load', atLeast: 2, severity: 'warning', message: 'm' }
      ],
      /"x" appears twice/
    ]
  ])('rejects an invalid file (%#)', (rules, problem) => {
    expect(() => resolveRules(withFile(rules))).toThrow(problem);
    expect(() => resolveRules(withFile(rules))).toThrow(AlertRulesError);
  });

  it('names the file when it is not JSON or has no rules array', () => {
    const bad = (text: string) => resolveRules({ ...base, file: { name: 'alerts.json', text } });
    expect(() => bad('{ rules: [')).toThrow(/alerts\.json is not valid JSON/);
    expect(() => bad('[]')).toThrow(/alerts\.json must be an object with a "rules" array/);
  });
});

describe('readRulesFile', () => {
  it('reads the file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'alerts.json');
    writeFileSync(path, '{"rules":[]}');
    expect(readRulesFile(path)).toEqual({ name: path, text: '{"rules":[]}' });
  });

  it('explains a missing file in one line, naming the variable and path', () => {
    expect(() => readRulesFile('/nonexistent/alerts.json')).toThrow(
      /^PIPULSE_ALERTS_FILE \/nonexistent\/alerts\.json could not be read: ENOENT$/
    );
  });
});
