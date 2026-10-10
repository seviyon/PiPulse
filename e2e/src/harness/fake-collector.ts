import { builtinPlugins as realPlugins, type CollectorPlugin } from '@pipulse/collector';
import { FAKE_INTERVAL_MS, READINGS_ENV, readReadings } from './readings.js';

// The module hook serves this file in place of '@pipulse/collector' to the server only.
// Everything else is the real package; the one export below shadows its own.
export * from '@pipulse/collector';

/** Same id, label, unit and API version as each built-in; the value comes from the control file. */
export const builtinPlugins: CollectorPlugin[] = realPlugins.map(
  ({ id, label, unit, apiVersion }): CollectorPlugin => ({
    id,
    label,
    unit,
    apiVersion,
    intervalMs: FAKE_INTERVAL_MS,
    async collect() {
      const path = process.env[READINGS_ENV];
      if (!path)
        throw new Error(`${READINGS_ENV} is not set: the harness did not start this server`);
      return readReadings(path)[id] ?? null;
    }
  })
);
