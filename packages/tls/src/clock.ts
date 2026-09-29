import { existsSync } from 'node:fs';
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
 * ordering only, never proof. `notBefore` is passed for generated leaves only:
 * PiPulse never issues one dated in the future, so being before it means the
 * clock is behind.
 */
export function readClock(options: {
  timesyncDir: string;
  now: number;
  trust: boolean;
  notBefore?: number;
  exists?: (path: string) => boolean;
}): ClockReading {
  const exists = options.exists ?? existsSync;
  let state: ClockState = exists(options.timesyncDir)
    ? exists(join(options.timesyncDir, 'synchronized'))
      ? 'synced'
      : 'unsynced'
    : 'unknown';
  if (
    options.now < CLOCK_FLOOR_MS ||
    (options.notBefore !== undefined && options.now < options.notBefore)
  ) {
    state = 'unsynced';
  }
  return { state, synced: state === 'synced' || (state === 'unknown' && options.trust) };
}
