import type { Context } from './cli-common.js';
import { CLOCK_FLOOR_MS } from './clock.js';

export const CLOCK_WAIT_MS = 60_000;

/**
 * Whether certificates issued now get the right dates. A synced clock (or
 * PIPULSE_TLS_CLOCK=trust) always passes. `lenient` (making a CA: an operator
 * at the console, setup, the sidecar's first start) also accepts an unknown
 * clock that reads past CLOCK_FLOOR_MS, with a warning. An unsynced clock is
 * waited for up to waitMs, and never issued on.
 */
export async function issuanceClock(
  ctx: Pick<Context, 'clock' | 'now' | 'sleep' | 'err'>,
  options: { lenient: boolean; waitMs: number }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = ctx.now() + options.waitMs;
  for (;;) {
    const clock = ctx.clock();
    if (clock.synced) return { ok: true };
    if (clock.state === 'unknown') {
      if (options.lenient && ctx.now() >= CLOCK_FLOOR_MS) {
        ctx.err(
          'warning: this system gives no clock synchronization signal (not systemd-timesyncd?); issuing with the current time. If chrony or ntpd keeps the clock right, set PIPULSE_TLS_CLOCK=trust in pipulse.env, or renewals will wait.'
        );
        return { ok: true };
      }
      return {
        ok: false,
        reason:
          'no clock synchronization signal: set PIPULSE_TLS_CLOCK=trust in pipulse.env if chrony or ntpd keeps this clock right'
      };
    }
    if (ctx.now() >= deadline) {
      return {
        ok: false,
        reason:
          'the clock is not synchronized yet; try again once `timedatectl` says "System clock synchronized: yes"'
      };
    }
    await ctx.sleep(2000);
  }
}
