import { describe, expect, it } from 'vitest';
import { meterMax, statusFor } from '../src/status.js';

describe('statusFor', () => {
  it.each([
    ['cpu_temperature', 55, 'ok'],
    ['cpu_temperature', 72, 'warning'],
    ['cpu_temperature', 81, 'critical'],
    ['disk_used', 57, 'ok'],
    ['disk_used', 85, 'warning'],
    ['disk_used', 93, 'critical'],
    ['cpu_load', 40, 'ok'],
    ['cpu_load', 95, 'warning'],
    ['swap_used', 40, 'ok'],
    ['swap_used', 81, 'warning'],
    ['swap_used', 96, 'critical'],
    ['boot_used', 92, 'critical'],
    ['throttled', 0, 'ok'],
    ['throttled', 0x50000, 'warning'],
    ['throttled', 0x50005, 'critical'],
    ['network_rx', 1e9, 'ok']
  ])('%s at %s is %s', (metric, value, level) => {
    expect(statusFor(metric, value).level).toBe(level);
  });

  it('explains every non-ok status in words, so color never carries it alone', () => {
    expect(statusFor('cpu_temperature', 81).label).toBe('Throttling likely');
    expect(statusFor('disk_used', 85).label).toBe('Filling up');
    expect(statusFor('cpu_temperature', 50).label).toBeUndefined();
  });
});

describe('throttle status', () => {
  it('names what is happening now', () => {
    expect(statusFor('throttled', 0x5).label).toBe('Under-voltage, throttled');
  });

  it('names what happened since boot when nothing is happening now', () => {
    expect(statusFor('throttled', 0x50000).label).toBe('Under-voltage, throttled since boot');
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
