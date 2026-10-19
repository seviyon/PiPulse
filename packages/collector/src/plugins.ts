import os from 'node:os';
import si, { type Systeminformation } from 'systeminformation';
import type { CollectorPlugin } from './plugin.js';
import { cpuVoltagePlugin, throttledPlugin } from './vcgencmd.js';
import { swapIoPlugin } from './swap-io.js';

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

/**
 * The 1-minute load average: tasks running or waiting, for a CPU or for
 * disk I/O. Unlike CPU load it rises when the SD card stalls, and above the
 * core count it means work is queueing. The 5- and 15-minute averages are
 * deliberately not collected: the kernel derives them from the same run
 * queue over longer windows, and History's longer ranges already show the
 * trend they would.
 */
export const loadPlugin: CollectorPlugin = {
  id: 'load_1',
  label: 'Load (1 min)',
  unit: '',
  intervalMs: 30000,
  apiVersion: 1,
  async collect() {
    // Windows has no load average; Node reports [0, 0, 0] there.
    return os.platform() === 'win32' ? null : (os.loadavg()[0] ?? null);
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

export const swapUsedPlugin: CollectorPlugin = {
  id: 'swap_used',
  label: 'Swap used',
  unit: '%',
  intervalMs: 10000,
  apiVersion: 1,
  async collect() {
    const mem = await si.mem();
    return mem.swaptotal > 0 ? (mem.swapused / mem.swaptotal) * 100 : null;
  }
};

export const bootUsedPlugin: CollectorPlugin = {
  id: 'boot_used',
  label: 'Disk used (/boot)',
  unit: '%',
  intervalMs: 60000,
  apiVersion: 1,
  async collect() {
    // Raspberry Pi OS mounts the boot partition at /boot, or /boot/firmware since bookworm.
    const filesystems = await si.fsSize();
    const boot = filesystems.find((fs) => fs.mount === '/boot' || fs.mount === '/boot/firmware');
    return nonNegativeOrNull(boot?.use);
  }
};

export const cpuFrequencyPlugin: CollectorPlugin = {
  id: 'cpu_frequency',
  label: 'CPU frequency',
  unit: 'MHz',
  intervalMs: 10000,
  apiVersion: 1,
  async collect() {
    const speed = await si.cpuCurrentSpeed();
    // si reports GHz; 0 means it couldn't read the clock.
    return speed.avg > 0 ? Math.round(speed.avg * 1000) : null;
  }
};

export { cpuVoltagePlugin, throttledPlugin };
export { describePluginError, VcgencmdOutputError } from './vcgencmd.js';
export { createSwapIoPlugin, swapIoPlugin, swapPages } from './swap-io.js';

export const builtinPlugins: CollectorPlugin[] = [
  cpuLoadPlugin,
  loadPlugin,
  cpuTemperaturePlugin,
  cpuFrequencyPlugin,
  cpuVoltagePlugin,
  throttledPlugin,
  memoryUsedPlugin,
  swapUsedPlugin,
  swapIoPlugin,
  diskUsedPlugin,
  bootUsedPlugin,
  networkRxPlugin,
  networkTxPlugin
];
