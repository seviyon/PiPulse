import { pathExists } from '../common/files.js';
import { join } from 'node:path';

export type ClockState = 'synced' | 'unsynced' | 'unknown';

/**
 * No real clock reads earlier than this (the first release with HTTPS). A Pi
 * has no RTC: it boots near 1970 or at its last shutdown time until NTP syncs.
 */
export const CLOCK_FLOOR_MS = Date.UTC(2026, 8, 1);

export interface ClockReading {
  state: ClockState;
  /** Counts as synced: 'synced', or 'unknown' with PIPULSE_TLS_CLOCK=trust. */
  synced: boolean;
}

/**
 * systemd-timesyncd (Pi OS) keeps `<timesyncDir>/synchronized` while the clock
 * is synced; no directory means no timesyncd (chrony, ntpd, a container
 * without the host's mount) → 'unknown'. systemd's After=time-sync.target is
 * ordering only, never proof. A leaf dated in the future is not read as "the clock is
 * behind": a clock that ran ahead once and came back leaves exactly that, and renew must
 * be able to replace it (see renewDue).
 */
export function readClock(options: {
  timesyncDir: string;
  now: number;
  trust: boolean;
  exists?: (path: string) => boolean;
}): ClockReading {
  const exists = options.exists ?? pathExists;
  let state: ClockState;
  try {
    state = exists(options.timesyncDir)
      ? exists(join(options.timesyncDir, 'synchronized'))
        ? 'synced'
        : 'unsynced'
      : 'unknown';
  } catch {
    // An unreadable directory is not "no timesyncd": it may be there and not synced.
    state = 'unsynced';
  }
  if (options.now < CLOCK_FLOOR_MS) state = 'unsynced';
  return { state, synced: state === 'synced' || (state === 'unknown' && options.trust) };
}
