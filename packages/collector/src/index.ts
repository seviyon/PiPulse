import si from 'systeminformation';
import { insertSample, type PiPulseDb } from '@pipulse/storage';

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

export const builtinPlugins: CollectorPlugin[] = [cpuLoadPlugin, memoryUsedPlugin];

/**
 * Polls every given plugin once and writes each successful reading to
 * storage with the current timestamp. A plugin whose collect() rejects or
 * returns null is skipped (and its error surfaced via `onError`, if given)
 * rather than aborting the whole run.
 */
export async function runOnce(
  db: PiPulseDb,
  plugins: CollectorPlugin[],
  onError?: (plugin: CollectorPlugin, error: unknown) => void
): Promise<void> {
  const ts = Date.now();
  await Promise.all(
    plugins.map(async (plugin) => {
      try {
        const value = await plugin.collect();
        if (value !== null && Number.isFinite(value)) {
          insertSample(db, { ts, metric: plugin.id, value });
        }
      } catch (error) {
        onError?.(plugin, error);
      }
    })
  );
}
