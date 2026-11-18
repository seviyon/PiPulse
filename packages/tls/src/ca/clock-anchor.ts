import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../common/files.js';
import { pub, type Layout } from './layout.js';

/**
 * A second opinion on the wall clock for the unattended `renew`. A Pi has no RTC, and a bad NTP
 * answer can leave the clock days ahead for a while ("synchronized" is still true); a leaf issued
 * then is dated in the future. `renew` is one short process per hour, so it keeps one number
 * between runs: the wall clock minus the time since boot (the kernel's boot clock does not follow
 * clock steps). That offset is steady for as long as the clock is; a step shows up as a change.
 * A step forward, or forward drift that adds up past ANCHOR_TOLERANCE_MS, is not believed until it
 * has held for ANCHOR_HOLD_MS, the same idea as the server's housekeeping and alert engine. A step back is harmless and just followed.
 */
export const ANCHOR_FILE = 'clock-anchor.json';
/** Wall clock vs boot clock may drift this much between runs (slewing, rounding) without comment. */
export const ANCHOR_TOLERANCE_MS = 10 * 60_000;
/** A forward step is believed once it has held this long. */
export const ANCHOR_HOLD_MS = 30 * 60_000;
/** Smaller changes are not worth a write. */
const REWRITE_AFTER_MS = 60_000;
/**
 * A doubted offset counts as holding only while it stays this steady: a clock that stepped and
 * then runs true does not move, a clock that keeps gaining does, and must not be believed for
 * having been ahead for a while. A clock can still gain up to about this much per hold period
 * (roughly 24 minutes a day) unnoticed: the limit is rate, not prevention.
 */
const STEADY_MS = 60_000;

export interface Anchor {
  version: 1;
  bootId: string;
  /**
   * Wall-clock ms minus ms since boot: the base every run is judged against. It moves back with
   * the clock, and forward only when a step has held for ANCHOR_HOLD_MS (never by small drift).
   */
  offsetMs: number;
  /** A forward step seen but not yet believed: its offset, and the uptime it was first seen at. */
  candidate?: { offsetMs: number; uptimeMs: number };
}

export interface ClockNow {
  bootId: string;
  offsetMs: number;
  uptimeMs: number;
}

export type Verdict =
  { ok: true; next?: Anchor } | { ok: false; next?: Anchor; aheadMs: number; heldMs: number };

const fresh = (now: ClockNow): Anchor => ({
  version: 1,
  bootId: now.bootId,
  offsetMs: now.offsetMs
});

/** Whether the clock may be used to date a new certificate, and the anchor to keep afterwards. */
export function judgeClock(anchor: Anchor | undefined, now: ClockNow): Verdict {
  if (anchor === undefined || anchor.bootId !== now.bootId) return { ok: true, next: fresh(now) };
  const delta = now.offsetMs - anchor.offsetMs;
  if (delta <= ANCHOR_TOLERANCE_MS) {
    // A step back is followed. A small step forward is believed for this run but never moves the
    // base, so steps that each stay under the tolerance still add up against it and are caught
    // (a clock creeping ahead 9 minutes per run would otherwise never be doubted).
    if (delta < -REWRITE_AFTER_MS) return { ok: true, next: fresh(now) };
    return anchor.candidate
      ? { ok: true, next: { version: 1, bootId: anchor.bootId, offsetMs: anchor.offsetMs } }
      : { ok: true };
  }
  const seen = anchor.candidate;
  if (seen && Math.abs(now.offsetMs - seen.offsetMs) <= STEADY_MS) {
    const heldMs = now.uptimeMs - seen.uptimeMs;
    if (heldMs >= ANCHOR_HOLD_MS) return { ok: true, next: fresh(now) };
    return { ok: false, aheadMs: delta, heldMs };
  }
  return {
    ok: false,
    aheadMs: delta,
    heldMs: 0,
    next: { ...anchor, candidate: { offsetMs: now.offsetMs, uptimeMs: now.uptimeMs } }
  };
}

/** Exported for tests: `readAnchor` catches a throw, so only a direct call shows a guard missing. */
export const isAnchor = (value: unknown): value is Anchor => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const c = v['candidate'];
  return (
    v['version'] === 1 &&
    typeof v['bootId'] === 'string' &&
    Number.isFinite(v['offsetMs']) &&
    (c === undefined ||
      (typeof c === 'object' &&
        c !== null &&
        Number.isFinite((c as Record<string, unknown>)['offsetMs']) &&
        Number.isFinite((c as Record<string, unknown>)['uptimeMs'])))
  );
};

/** The stored anchor; a missing, damaged or foreign file is no anchor (the next run starts one). */
export function readAnchor(layout: Layout): Anchor | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(layout.tlsDir, ANCHOR_FILE), 'utf8'));
    return isAnchor(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeAnchor(layout: Layout, anchor: Anchor): void {
  writeAtomic(join(layout.tlsDir, ANCHOR_FILE), `${JSON.stringify(anchor)}\n`, {
    mode: 0o644,
    owner: pub(layout)
  });
}

/** "2 d 3 h" style, for the one line `status` shows. */
export function aheadText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
