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
