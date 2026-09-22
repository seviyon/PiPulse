import { describe, expect, it } from 'vitest';
import { formatAge, formatValue } from '../src/format.js';

describe('formatValue', () => {
  it.each([
    [1.6080402010050252, '%', '1.6', '%'],
    [48.7, '°C', '48.7', '°C'],
    [249.69, 'MB', '250', 'MB'],
    [1536, 'MB', '1.5', 'GB'],
    [96.64536741214057, 'B/s', '97', 'B/s'],
    [1536, 'B/s', '1.5', 'kB/s'],
    [2_500_000, 'B/s', '2.5', 'MB/s'],
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
