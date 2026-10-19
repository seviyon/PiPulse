import { describe, expect, it } from 'vitest';
import { CLOCK_FLOOR_MS, readClock } from '../../src/settings/clock.js';

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

  it('treats a directory it cannot inspect as unsynced, never as absent', () => {
    const denied = () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    expect(readClock({ timesyncDir: DIR, now: NOW, trust: true, exists: denied })).toEqual({
      state: 'unsynced',
      synced: false
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

  it('does not read a clock that timesyncd calls synced as unsynced because of a leaf dated ahead', () => {
    // Such a leaf is what a clock that ran ahead and came back leaves; renew replaces it (renewDue).
    expect(
      readClock({
        timesyncDir: DIR,
        now: NOW,
        trust: false,
        exists: files(DIR, `${DIR}/synchronized`)
      }).state
    ).toBe('synced');
  });

  it('counts exactly the floor as a real time', () => {
    expect(
      readClock({ timesyncDir: DIR, now: CLOCK_FLOOR_MS, trust: true, exists: files() }).state
    ).toBe('unknown');
    expect(
      readClock({ timesyncDir: DIR, now: CLOCK_FLOOR_MS - 1, trust: true, exists: files() }).state
    ).toBe('unsynced');
  });
});
