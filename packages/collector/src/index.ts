import si, { type Systeminformation } from 'systeminformation';
import { insertSample, type PiPulseDb, type Sample } from '@pipulse/storage';

/**
 * The stable contract between core and any collector plugin, built-in or
 * third-party. Keep this interface narrow and change it deliberately —
 * it is versioned on its own (see PLUGIN_API_VERSION), separate from the
 * app's own version, so a plugin can declare which shape it was built for.
 */
export interface CollectorPlugin {
  /** Unique, stable metric id (used as the `metric` column value). */
  readonly id: string;
  /** Human-readable label for the dashboard. */
  readonly label: string;
  /** Unit shown next to the value, e.g. "%", "°C", "MiB/s". */
  readonly unit: string;
  /** How often this plugin should be polled, in milliseconds. */
  readonly intervalMs: number;
  /** The plugin API version this plugin was written against. */
  readonly apiVersion: 1;
  /** Reads the current value. Return `null` when the metric is unavailable. */
  collect(): Promise<number | null>;
}

export const PLUGIN_API_VERSION = 1;

/** setInterval's ceiling; larger delays overflow and fire every 1 ms instead. */
export const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * Checks a plugin's manifest against the CollectorPlugin contract and
 * returns every violation found (empty when valid). Runs at runtime, not
 * just at compile time, because third-party plugins are loaded dynamically
 * — so it takes `unknown` and checks every field's type, not just its value.
 */
export function validatePlugin(plugin: unknown): string[] {
  if (typeof plugin !== 'object' || plugin === null) {
    return ['plugin must be an object'];
  }
  const { id, label, unit, intervalMs, apiVersion, collect } = plugin as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id)) {
    problems.push('id must be lowercase snake_case');
  }
  if (typeof label !== 'string' || label.trim() === '') {
    problems.push('label must not be empty');
  }
  if (typeof unit !== 'string') {
    problems.push('unit must be a string');
  }
  if (
    typeof intervalMs !== 'number' ||
    !Number.isInteger(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > MAX_INTERVAL_MS
  ) {
    problems.push(`intervalMs must be a positive integer no greater than ${MAX_INTERVAL_MS}`);
  }
  if (apiVersion !== PLUGIN_API_VERSION) {
    problems.push(
      `apiVersion ${String(apiVersion)} is not supported (expected ${PLUGIN_API_VERSION})`
    );
  }
  if (typeof collect !== 'function') {
    problems.push('collect must be a function');
  }
  return problems;
}

export const cpuLoadPlugin: CollectorPlugin = {
  id: 'cpu_load',
  label: 'CPU load',
  unit: '%',
  intervalMs: 5000,
  apiVersion: 1,
  async collect() {
    const load = await si.currentLoad();
    return load.currentLoad;
  }
};

export const memoryUsedPlugin: CollectorPlugin = {
  id: 'memory_used',
  label: 'Memory used',
  unit: 'MB',
  intervalMs: 5000,
  apiVersion: 1,
  async collect() {
    const mem = await si.mem();
    return Math.round((mem.active / 1024 / 1024) * 100) / 100;
  }
};

/**
 * Accepts only real, non-negative readings. systeminformation reports
 * `null` for a rate it can't compute yet (the first network poll) and
 * `-1` for a missing sensor on some platforms.
 */
function nonNegativeOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

let networkStatsInFlight: Promise<Systeminformation.NetworkStatsData[]> | undefined;

/**
 * systeminformation keeps one module-global byte counter per interface and
 * computes rates against whichever call came before. The rx and tx plugins
 * fire on the same tick, so two overlapping reads would leave the second
 * measuring a ~0 ms window (NaN or 0). Overlapping callers share one read;
 * sequential ones are safe, since si serves reads <500 ms apart from cache.
 */
function sharedNetworkStats(): Promise<Systeminformation.NetworkStatsData[]> {
  networkStatsInFlight ??= si.networkStats().finally(() => {
    networkStatsInFlight = undefined;
  });
  return networkStatsInFlight;
}

/** Throughput of the default network interface; `si` returns it first in the list. */
async function defaultInterfaceRate(direction: 'rx_sec' | 'tx_sec'): Promise<number | null> {
  const [stats] = await sharedNetworkStats();
  return nonNegativeOrNull(stats?.[direction]);
}

export const networkRxPlugin: CollectorPlugin = {
  id: 'network_rx',
  label: 'Network received',
  unit: 'B/s',
  intervalMs: 5000,
  apiVersion: 1,
  collect: () => defaultInterfaceRate('rx_sec')
};

export const networkTxPlugin: CollectorPlugin = {
  id: 'network_tx',
  label: 'Network sent',
  unit: 'B/s',
  intervalMs: 5000,
  apiVersion: 1,
  collect: () => defaultInterfaceRate('tx_sec')
};

export const diskUsedPlugin: CollectorPlugin = {
  id: 'disk_used',
  label: 'Disk used (/)',
  unit: '%',
  intervalMs: 60000,
  apiVersion: 1,
  async collect() {
    const filesystems = await si.fsSize();
    return nonNegativeOrNull(filesystems.find((fs) => fs.mount === '/')?.use);
  }
};

export const cpuTemperaturePlugin: CollectorPlugin = {
  id: 'cpu_temperature',
  label: 'CPU temperature',
  unit: '°C',
  intervalMs: 10000,
  apiVersion: 1,
  async collect() {
    const temperature = await si.cpuTemperature();
    return nonNegativeOrNull(temperature.main);
  }
};

export const builtinPlugins: CollectorPlugin[] = [
  cpuLoadPlugin,
  memoryUsedPlugin,
  networkRxPlugin,
  networkTxPlugin,
  diskUsedPlugin,
  cpuTemperaturePlugin
];

export type PluginErrorHandler = (plugin: CollectorPlugin, error: unknown) => void;

export type SampleListener = (sample: Sample) => void;

/**
 * Polls one plugin and writes a successful reading to storage, stamped
 * with the time the reading completed. A null or non-finite value is
 * skipped; a rejection is passed to `onError` instead of propagating.
 */
async function collectAndStore(
  db: PiPulseDb,
  plugin: CollectorPlugin,
  onError?: PluginErrorHandler,
  onSample?: SampleListener
): Promise<void> {
  let sample: Sample;
  try {
    const value = await plugin.collect();
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

  const poll = (plugin: CollectorPlugin) => {
    if (inFlight.has(plugin)) return;
    const run = collectAndStore(db, plugin, options.onError, options.onSample).finally(() => {
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
