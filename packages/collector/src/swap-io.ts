import { readFile } from 'node:fs/promises';
import type { CollectorPlugin } from './index.js';

/** Pages swapped in plus out since boot, from /proc/vmstat; null if either counter is missing. */
export function swapPages(vmstat: string): number | null {
  const counter = (name: string) => {
    const match = new RegExp(`^${name} (\\d+)$`, 'm').exec(vmstat);
    return match ? Number(match[1]) : undefined;
  };
  const pagesIn = counter('pswpin');
  const pagesOut = counter('pswpout');
  return pagesIn === undefined || pagesOut === undefined ? null : pagesIn + pagesOut;
}

/** /proc/vmstat, or null where there is none (not Linux). */
async function readVmstat(): Promise<string | null> {
  try {
    return await readFile('/proc/vmstat', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Swap traffic in pages/s: how hard the system is swapping right now.
 * Unlike swap_used, it stays near zero when idle pages merely sit parked in
 * a small swap file, so it is what the swap_heavy alert watches.
 */
export function createSwapIoPlugin(
  options: { read?: () => Promise<string | null>; now?: () => number } = {}
): CollectorPlugin {
  const read = options.read ?? readVmstat;
  // Monotonic, so an NTP jump can't produce a negative or huge rate.
  const now = options.now ?? (() => performance.now());
  let previous: { pages: number; at: number } | undefined;
  return {
    id: 'swap_io',
    label: 'Swap traffic',
    unit: 'pages/s',
    intervalMs: 10000,
    apiVersion: 1,
    async collect() {
      const text = await read();
      const pages = text === null ? null : swapPages(text);
      const at = now();
      const before = previous;
      previous = pages === null ? undefined : { pages, at };
      if (pages === null || !before || pages < before.pages || at <= before.at) return null;
      return Math.round(((pages - before.pages) / ((at - before.at) / 1000)) * 100) / 100;
    }
  };
}

export const swapIoPlugin = createSwapIoPlugin();
