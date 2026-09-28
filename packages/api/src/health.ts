import type { PiPulseDb } from '@pipulse/storage';

/** Collection counts as stopped after this long without a stored reading. */
export const READING_STALE_MS = 5 * 60_000;

export interface HealthResult {
  ok: boolean;
  problems: string[];
}

export interface Health {
  /** Call on every stored reading (the scheduler's onSample). */
  markReading(): void;
  check(): HealthResult;
}

/**
 * Liveness for container managers and the installer: the database answers,
 * and (when tracking readings) something was stored recently. Measured on a
 * monotonic clock, so a wall-clock jump (NTP after boot) can't flip it.
 */
export function createHealth(
  db: PiPulseDb,
  options: { monotonic?: () => number; trackReadings?: boolean } = {}
): Health {
  const monotonic = options.monotonic ?? (() => performance.now());
  // Start counts as a reading: the first poll gets the full grace period.
  let lastReading = monotonic();
  return {
    markReading() {
      lastReading = monotonic();
    },
    check() {
      const problems: string[] = [];
      try {
        db.prepare('SELECT 1').get();
      } catch {
        problems.push('database unavailable');
      }
      if (options.trackReadings && monotonic() - lastReading >= READING_STALE_MS) {
        problems.push('no readings for 5 min');
      }
      return { ok: problems.length === 0, problems };
    }
  };
}
