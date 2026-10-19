import { insertSample, type PiPulseDb, type Sample } from '@pipulse/storage';
import { validatePlugin, type CollectorPlugin } from './plugin.js';

export type PluginErrorHandler = (plugin: CollectorPlugin, error: unknown) => void;

export type SampleListener = (sample: Sample) => void;

/** A read's deadline, and what to tell the scheduler when a read is given up on. */
interface Deadline {
  ms: number;
  /** Called when a read is given up on; `settled` resolves when the abandoned read finally ends. */
  onOrphan(settled: Promise<void>): void;
}

const noop = () => {};

/**
 * `promise`, or a rejection if it has not settled within `ms` (its late answer is then ignored,
 * and `onOrphan` is told, so the scheduler can count reads that are still hanging).
 */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  id: string,
  onOrphan: (settled: Promise<void>) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onOrphan(promise.then(noop, noop));
      reject(new Error(`${id}: collect() did not finish within ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * How many given-up reads of one plugin may still be hanging before the scheduler stops starting
 * more: a read that never settles (a driver call stuck for good) would otherwise leave one more
 * behind every deadline, for as long as the Pi runs. One that comes back frees its slot.
 */
const MAX_ORPHANED_READS = 3;

/**
 * How long a plugin's collect() may take before the scheduler gives up on it: three intervals,
 * at most 30 s. Without a limit one read that never settles (a firmware call stuck in the
 * kernel) holds the plugin's slot for good, every later tick is skipped, and the metric just
 * stops until the service restarts.
 */
const collectDeadline = (plugin: CollectorPlugin) => Math.min(plugin.intervalMs * 3, 30_000);

/**
 * Polls one plugin and writes a successful reading to storage, stamped
 * with the time the reading completed. A null or non-finite value is
 * skipped; a rejection is passed to `onError` instead of propagating.
 */
async function collectAndStore(
  db: PiPulseDb,
  plugin: CollectorPlugin,
  onError?: PluginErrorHandler,
  onSample?: SampleListener,
  deadline?: Deadline
): Promise<void> {
  let sample: Sample;
  try {
    const value =
      deadline === undefined
        ? await plugin.collect()
        : await withDeadline(plugin.collect(), deadline.ms, plugin.id, deadline.onOrphan);
    if (value === null || !Number.isFinite(value)) return;
    sample = { ts: Date.now(), metric: plugin.id, value };
    insertSample(db, sample);
  } catch (error) {
    onError?.(plugin, error);
    return;
  }
  try {
    onSample?.(sample);
  } catch (error) {
    onError?.(plugin, error);
  }
}

/**
 * Polls every given plugin once and writes each successful reading to
 * storage. A plugin whose collect() rejects or returns null is skipped
 * (and its error surfaced via `onError`, if given) rather than aborting
 * the whole run.
 */
export async function runOnce(
  db: PiPulseDb,
  plugins: CollectorPlugin[],
  onError?: PluginErrorHandler
): Promise<void> {
  await Promise.all(plugins.map((plugin) => collectAndStore(db, plugin, onError)));
}

export interface SchedulerOptions {
  onError?: PluginErrorHandler;
  /**
   * Called with every sample right after it is written to storage — the
   * hook the API uses to push live updates. A throwing listener is
   * reported via `onError` and never stops polling.
   */
  onSample?: SampleListener;
}

export interface Scheduler {
  /**
   * Stops all polling and waits for in-flight collections to be written.
   * Resolves `true` once they have all settled, or `false` if `timeoutMs`
   * elapsed first (a hung sensor read) — in which case a late reading may
   * still try to write, so the caller should exit rather than keep using
   * the db. Waits indefinitely when no timeout is given.
   */
  stop(timeoutMs?: number): Promise<boolean>;
}

/**
 * Polls each plugin immediately and then every `intervalMs`, independently
 * of the others. If a plugin's previous collect() hasn't finished when its
 * next tick fires, that tick is skipped rather than stacking up overlapping
 * reads on a slow sensor. Throws if any plugin violates the contract or
 * two plugins share an id (they would overwrite each other's samples).
 */
export function startScheduler(
  db: PiPulseDb,
  plugins: CollectorPlugin[],
  options: SchedulerOptions = {}
): Scheduler {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    const problems = validatePlugin(plugin);
    if (problems.length > 0) {
      throw new Error(`Invalid plugin "${String(plugin.id)}": ${problems.join('; ')}`);
    }
    if (ids.has(plugin.id)) {
      throw new Error(`Duplicate plugin id "${plugin.id}"`);
    }
    ids.add(plugin.id);
  }

  const inFlight = new Map<CollectorPlugin, Promise<void>>();
  // Reads given up on that have still not settled, per plugin, and whether the cap was reported.
  const orphans = new Map<CollectorPlugin, number>();
  const reported = new Set<CollectorPlugin>();

  const adjustOrphans = (plugin: CollectorPlugin, by: number) =>
    orphans.set(plugin, (orphans.get(plugin) ?? 0) + by);

  const poll = (plugin: CollectorPlugin) => {
    if (inFlight.has(plugin)) return;
    const hanging = orphans.get(plugin) ?? 0;
    if (hanging >= MAX_ORPHANED_READS) {
      if (!reported.has(plugin)) {
        reported.add(plugin);
        options.onError?.(
          plugin,
          new Error(
            `${plugin.id}: ${hanging} earlier reads are still hanging; not starting another until one finishes`
          )
        );
      }
      return;
    }
    const run = collectAndStore(db, plugin, options.onError, options.onSample, {
      ms: collectDeadline(plugin),
      onOrphan: (settled) => {
        adjustOrphans(plugin, +1);
        void settled.then(() => {
          adjustOrphans(plugin, -1);
          reported.delete(plugin);
        });
      }
    }).finally(() => {
      inFlight.delete(plugin);
    });
    inFlight.set(plugin, run);
  };

  const timers = plugins.map((plugin) => {
    poll(plugin);
    return setInterval(() => poll(plugin), plugin.intervalMs);
  });

  return {
    async stop(timeoutMs?: number) {
      timers.forEach(clearInterval);
      const drained = Promise.all(inFlight.values()).then(() => true);
      if (timeoutMs === undefined) return drained;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        return await Promise.race([drained, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
