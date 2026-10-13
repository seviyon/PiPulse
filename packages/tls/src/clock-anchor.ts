import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './files.js';
import { pub, type Layout } from './layout.js';

/**
 * A second opinion on the wall clock for the unattended `renew`. A Pi has no RTC, and a bad NTP
 * answer can leave the clock days ahead for a while ("synchronized" is still true); a leaf issued
 * then is dated in the future. `renew` is one short process per hour, so it keeps one number
 * between runs: the wall clock minus the time since boot (the kernel's boot clock does not follow
 * clock steps). That offset is steady for as long as the clock is; a step shows up as a change.
 * A step forward is not believed until it has held for ANCHOR_HOLD_MS, the same idea as the
 * server's housekeeping and alert engine. A step back is harmless and just followed.
 */
export const ANCHOR_FILE = 'clock-anchor.json';
/** Wall clock vs boot clock may drift this much between runs (slewing, rounding) without comment. */
export const ANCHOR_TOLERANCE_MS = 10 * 60_000;
/** A forward step is believed once it has held this long. */
export const ANCHOR_HOLD_MS = 30 * 60_000;
/** Smaller changes are not worth a write. */
const REWRITE_AFTER_MS = 60_000;

export interface Anchor {
  version: 1;
  bootId: string;
  /** Wall-clock ms minus ms since boot, when it was last believed. */
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
    // Followed (also when it went back); rewritten only when it moved or a doubt was cleared.
    const moved = Math.abs(delta) > REWRITE_AFTER_MS;
    return moved || anchor.candidate ? { ok: true, next: fresh(now) } : { ok: true };
  }
  const seen = anchor.candidate;
  if (seen && Math.abs(now.offsetMs - seen.offsetMs) <= ANCHOR_TOLERANCE_MS) {
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

const isAnchor = (value: unknown): value is Anchor => {
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
