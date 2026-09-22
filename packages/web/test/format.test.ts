import { describe, expect, it } from 'vitest';
import { formatAge, formatUptime, formatValue } from '../src/format.js';

describe('formatValue', () => {
  it.each([
    [1.6080402010050252, '%', '1.6', '%'],
    [48.7, '°C', '48.7', '°C'],
    [249.69, 'MB', '250', 'MB'],
    [1536, 'MB', '1.5', 'GB'],
    [96.64536741214057, 'B/s', '97', 'B/s'],
    [1536, 'B/s', '1.5', 'kB/s'],
    [2_500_000, 'B/s', '2.5', 'MB/s'],
    [1.2, 'V', '1.2', 'V'],
    [1.2375, 'V', '1.24', 'V'],
    [600.062, 'MHz', '600', 'MHz'],
    [0, 'flags', 'None', ''],
    [0x50005, 'flags', 'Now', ''],
    [0x50000, 'flags', 'Since boot', ''],
    [3.14159, 'widgets', '3.14', 'widgets']
  ])('formats %s %s as %s %s', (value, unit, text, shownUnit) => {
    expect(formatValue(value, unit)).toEqual({ text, unit: shownUnit });
  });

  it('drops a trailing .0 so whole numbers read cleanly', () => {
    expect(formatValue(50, '%')).toEqual({ text: '50', unit: '%' });
  });
});

describe('formatAge', () => {
  it.each([
    [500, 'just now'],
    [12_400, '12 s ago'],
    [59_400, '59 s ago'],
    [59_600, '1 min ago'],
    [60_000, '1 min ago'],
    [185_000, '3 min ago'],
    [3_599_600, '1 h ago'],
    [7_300_000, '2 h ago']
  ])('formats %i ms as "%s"', (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });
});

describe('formatUptime', () => {
  it.each([
    [5 * 60_000, '5 min'],
    [3 * 3_600_000 + 12 * 60_000, '3 h 12 min'],
    [16 * 86_400_000 + 11 * 3_600_000 + 53 * 60_000, '16 days 11 h'],
    [86_400_000 + 60_000, '1 day 0 h'],
    [-180_000, '0 min']
  ])('formats %i ms as "%s"', (ms, text) => {
    expect(formatUptime(ms)).toBe(text);
  });
});
