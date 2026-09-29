import { describe, expect, it } from 'vitest';
import { CLOCK_FLOOR_MS, readClock } from '../src/clock.js';

const NOW = Date.UTC(2027, 0, 1);
const files =
  (...present: string[]) =>
  (path: string) =>
    present.includes(path);
const DIR = '/run/systemd/timesync';

describe('readClock', () => {
  it('is synced when timesyncd says so', () => {
    expect(
      readClock({
        timesyncDir: DIR,
        now: NOW,
        trust: false,
        exists: files(DIR, `${DIR}/synchronized`)
      })
    ).toEqual({
      state: 'synced',
      synced: true
    });
  });

  it('is unsynced while timesyncd runs without having synced', () => {
    expect(readClock({ timesyncDir: DIR, now: NOW, trust: true, exists: files(DIR) })).toEqual({
      state: 'unsynced',
      synced: false
    });
  });

  it('is unknown without timesyncd, and counts as synced only with trust', () => {
    expect(readClock({ timesyncDir: DIR, now: NOW, trust: false, exists: files() })).toEqual({
      state: 'unknown',
      synced: false
    });
    expect(readClock({ timesyncDir: DIR, now: NOW, trust: true, exists: files() })).toEqual({
      state: 'unknown',
      synced: true
    });
  });

  it('is unsynced before the floor even if timesyncd says synced or the clock is trusted', () => {
    const early = CLOCK_FLOOR_MS - 1;
    expect(
      readClock({
        timesyncDir: DIR,
        now: early,
        trust: false,
        exists: files(DIR, `${DIR}/synchronized`)
      }).state
    ).toBe('unsynced');
    expect(readClock({ timesyncDir: DIR, now: early, trust: true, exists: files() })).toEqual({
      state: 'unsynced',
      synced: false
    });
  });

  it('is unsynced before a given notBefore (a generated leaf is never future-dated)', () => {
    expect(
      readClock({
        timesyncDir: DIR,
        now: NOW,
        trust: false,
        notBefore: NOW + 1,
        exists: files(DIR, `${DIR}/synchronized`)
      }).state
    ).toBe('unsynced');
  });
});
