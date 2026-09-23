import { describe, expect, it } from 'vitest';
import { meterMax, statusFor } from '../src/status.js';
import type { Rule } from '../src/types.js';

const rule = (r: Partial<Rule> & Pick<Rule, 'id' | 'metric' | 'severity' | 'message'>): Rule => ({
  forMs: 0,
  clearAfterMs: 0,
  source: 'built-in',
  ...r
});
const rules: Rule[] = [
  rule({
    id: 'cpu_warm',
    metric: 'cpu_temperature',
    atLeast: 70,
    severity: 'warning',
    message: 'CPU running warm'
  }),
  rule({
    id: 'cpu_hot',
    metric: 'cpu_temperature',
    atLeast: 80,
    severity: 'critical',
    message: 'CPU running hot'
  }),
  rule({
    id: 'disk_filling',
    metric: 'disk_used',
    atLeast: 70,
    severity: 'warning',
    message: 'Disk filling up'
  }),
  rule({
    id: 'throttled_now',
    metric: 'throttled',
    bitsSet: 0xf,
    severity: 'critical',
    message: 'Throttling now'
  }),
  rule({
    id: 'throttled_before',
    metric: 'throttled',
    bitsSet: 0xf0000,
    severity: 'warning',
    message: 'Throttled since boot'
  }),
  rule({
    id: 'not_collecting',
    metric: '*',
    noReadingFor: 'auto',
    severity: 'warning',
    message: 'No new readings'
  })
];

describe('statusFor', () => {
  it.each([
    ['cpu_temperature', 55, 'ok'],
    ['cpu_temperature', 72, 'warning'],
    ['cpu_temperature', 81, 'critical'],
    ['disk_used', 69.9, 'ok'],
    ['disk_used', 70, 'warning'],
    ['throttled', 0, 'ok'],
    ['throttled', 0x50000, 'warning'],
    ['throttled', 0x50005, 'critical'],
    ['network_rx', 1e9, 'ok']
  ])('%s at %s is %s', (metric, value, level) => {
    expect(statusFor(rules, metric, value).level).toBe(level);
  });

  it('names the most severe matching rule in words', () => {
    expect(statusFor(rules, 'cpu_temperature', 81).label).toBe('CPU running hot');
    expect(statusFor(rules, 'disk_used', 85).label).toBe('Disk filling up');
    expect(statusFor(rules, 'cpu_temperature', 50).label).toBeUndefined();
  });

  it('decodes throttle bits rather than repeating the rule message', () => {
    expect(statusFor(rules, 'throttled', 0x50005).label).toBe('Under-voltage, throttled');
    expect(statusFor(rules, 'throttled', 0x50000).label).toBe(
      'Under-voltage, throttled since boot'
    );
  });

  it('shows nothing without rules (an older server)', () => {
    expect(statusFor([], 'cpu_temperature', 99).level).toBe('ok');
  });
});

describe('meterMax', () => {
  it('gives bounded metrics a scale and leaves unbounded ones without', () => {
    expect(meterMax('cpu_load')).toBe(100);
    expect(meterMax('disk_used')).toBe(100);
    expect(meterMax('cpu_temperature')).toBe(85);
    expect(meterMax('network_rx')).toBeUndefined();
    expect(meterMax('swap_used')).toBe(100);
    expect(meterMax('boot_used')).toBe(100);
  });

  it('scales memory to the device total, when the server reports one', () => {
    expect(meterMax('memory_used', { memoryTotalMb: 971.52 })).toBe(971.52);
    expect(meterMax('memory_used', {})).toBeUndefined();
  });
});
