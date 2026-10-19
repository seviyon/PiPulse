import { describe, expect, it } from 'vitest';
import * as collector from '../src/index.js';

// What the package exports (types are erased), as of the split's base commit.
const EXPORTS = [
  'MAX_INTERVAL_MS',
  'PLUGIN_API_VERSION',
  'VcgencmdOutputError',
  'bootUsedPlugin',
  'builtinPlugins',
  'cpuFrequencyPlugin',
  'cpuLoadPlugin',
  'cpuTemperaturePlugin',
  'cpuVoltagePlugin',
  'createSwapIoPlugin',
  'describePluginError',
  'diskUsedPlugin',
  'hostOverrides',
  'loadPlugin',
  'memoryUsedPlugin',
  'networkRxPlugin',
  'networkTxPlugin',
  'readDeviceInfo',
  'runOnce',
  'startScheduler',
  'swapIoPlugin',
  'swapPages',
  'swapUsedPlugin',
  'throttledPlugin',
  'validatePlugin'
];

describe('the package entry', () => {
  it('exports exactly what it did before the split', () => {
    expect(Object.keys(collector).sort()).toEqual(EXPORTS);
  });

  it('lists the built-in plugins in the order the dashboard shows them', () => {
    expect(collector.builtinPlugins.map((p) => p.id)).toEqual([
      'cpu_load',
      'load_1',
      'cpu_temperature',
      'cpu_frequency',
      'cpu_voltage',
      'throttled',
      'memory_used',
      'swap_used',
      'swap_io',
      'disk_used',
      'boot_used',
      'network_rx',
      'network_tx'
    ]);
  });
});
