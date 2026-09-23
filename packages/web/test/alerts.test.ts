import { describe, expect, it } from 'vitest';
import {
  applyAlertEvent,
  describeRule,
  formatDuration,
  rangeCovering,
  worstAlert
} from '../src/alerts.js';
import type { Alert, PluginInfo } from '../src/types.js';

const alert = (id: number, severity: Alert['severity'], raisedAt: number): Alert => ({
  id,
  ruleId: `r${id}`,
  metric: 'cpu_temperature',
  severity,
  message: 'm',
  value: 1,
  raisedAt,
  clearedAt: null,
  clearedBy: null
});

describe('applyAlertEvent', () => {
  it('adds a raised alert first, replaces a known one, and drops a cleared one', () => {
    const a = alert(1, 'warning', 10);
    const b = alert(2, 'critical', 20);
    expect(applyAlertEvent([a], 'raised', b)).toEqual([b, a]);
    expect(applyAlertEvent([a, b], 'raised', { ...a, message: 'new' })).toEqual([
      { ...a, message: 'new' },
      b
    ]);
    expect(
      applyAlertEvent([a, b], 'cleared', { ...b, clearedAt: 30, clearedBy: 'condition' })
    ).toEqual([a]);
  });
});

describe('worstAlert', () => {
  it('prefers critical, then the longest open', () => {
    const warm = alert(1, 'warning', 10);
    const hot = alert(2, 'critical', 30);
    const hotter = alert(3, 'critical', 20);
    expect(worstAlert([warm, hot, hotter])).toBe(hotter);
    expect(worstAlert([warm])).toBe(warm);
    expect(worstAlert([])).toBeUndefined();
  });
});

const HOUR = 3_600_000;
const plugins: PluginInfo[] = [
  { id: 'cpu_temperature', label: 'CPU temperature', unit: '°C', intervalMs: 10_000 },
  { id: 'throttled', label: 'Throttling', unit: 'flags', intervalMs: 10_000 }
];
const base = {
  forMs: 0,
  clearAfterMs: 0,
  severity: 'warning' as const,
  message: 'm',
  source: 'built-in' as const
};

describe('rangeCovering', () => {
  it('picks the shortest History range reaching back to the raise', () => {
    expect(rangeCovering(0, 30 * 60_000)).toBe('1h');
    expect(rangeCovering(0, 5 * HOUR)).toBe('6h');
    expect(rangeCovering(0, 3 * 24 * HOUR)).toBe('7d');
    expect(rangeCovering(0, 400 * 24 * HOUR)).toBe('1y');
  });
});

describe('describeRule', () => {
  it('says each rule in words', () => {
    expect(
      describeRule(
        { ...base, id: 'a', metric: 'cpu_temperature', atLeast: 70, forMs: 600_000 },
        plugins
      )
    ).toBe('CPU temperature ≥ 70 °C for 10 min');
    expect(
      describeRule({ ...base, id: 'b', metric: 'throttled', bitsSet: 0xf, forMs: 60_000 }, plugins)
    ).toBe('Throttling: flags 0xf set for 1 min');
    expect(describeRule({ ...base, id: 'c', metric: '*', noReadingFor: 'auto' }, plugins)).toBe(
      'Any metric: no reading for 5 polls (at least 2 min)'
    );
    expect(
      describeRule({ ...base, id: 'd', metric: 'cpu_temperature', noReadingFor: 30_000 }, plugins)
    ).toBe('CPU temperature: no reading for 30 s');
  });

  it('formats durations in the largest whole unit', () => {
    expect([30_000, 120_000, 2 * HOUR, 90_000].map(formatDuration)).toEqual([
      '30 s',
      '2 min',
      '2 h',
      '90 s'
    ]);
  });
});
