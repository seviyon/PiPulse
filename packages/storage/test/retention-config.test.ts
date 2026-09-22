import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, retentionFromEnv } from '../src/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('retentionFromEnv', () => {
  it('uses the defaults when nothing is set', () => {
    expect(retentionFromEnv({})).toEqual(DEFAULT_RETENTION);
  });

  it('overrides only the resolutions that are set', () => {
    expect(retentionFromEnv({ PIPULSE_RETENTION_RAW: '30d', PIPULSE_RETENTION_1H: '5y' })).toEqual({
      ...DEFAULT_RETENTION,
      raw: 30 * DAY,
      '1h': 5 * 365 * DAY
    });
  });

  it.each([
    ['36h', 36 * HOUR],
    ['14d', 14 * DAY],
    ['2w', 14 * DAY],
    ['1y', 365 * DAY],
    ['1.5d', 1.5 * DAY],
    [' 7D ', 7 * DAY],
    ['forever', Infinity]
  ])('reads %j', (value, ms) => {
    expect(retentionFromEnv({ PIPULSE_RETENTION_1M: value })['1m']).toBe(ms);
  });

  it.each(['', '30', 'abc', '0d', '-1d', '10m', 'never'])(
    'rejects %j with a message naming the variable',
    (value) => {
      expect(() => retentionFromEnv({ PIPULSE_RETENTION_1D: value })).toThrow(
        /PIPULSE_RETENTION_1D.*like 36h, 14d, 2w, 1y or forever/
      );
    }
  );
});
