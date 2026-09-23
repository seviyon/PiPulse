import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('systeminformation', () => ({
  default: {
    networkStats: vi.fn(),
    fsSize: vi.fn(),
    cpuTemperature: vi.fn()
  }
}));

const si = (await import('systeminformation')).default;
const { networkRxPlugin, networkTxPlugin, diskUsedPlugin, cpuTemperaturePlugin, loadPlugin } =
  await import('../src/index.js');

afterEach(() => {
  vi.mocked(si.networkStats).mockReset();
  vi.mocked(si.fsSize).mockReset();
  vi.mocked(si.cpuTemperature).mockReset();
  vi.restoreAllMocks();
});

function mockNetworkStats(stats: { rx_sec: number | null; tx_sec: number | null }[]) {
  vi.mocked(si.networkStats).mockResolvedValue(stats as never);
}

describe('network plugins', () => {
  it('report receive and transmit throughput of the default interface in bytes/s', async () => {
    mockNetworkStats([{ rx_sec: 1536, tx_sec: 512 }]);

    expect(await networkRxPlugin.collect()).toBe(1536);
    expect(await networkTxPlugin.collect()).toBe(512);
  });

  it('share one systeminformation read when polled concurrently', async () => {
    // si computes rates against a global previous-read counter, so a second
    // overlapping read would measure a ~0 ms window (NaN/0). Assert one read.
    mockNetworkStats([{ rx_sec: 1536, tx_sec: 512 }]);

    const [rx, tx] = await Promise.all([networkRxPlugin.collect(), networkTxPlugin.collect()]);

    expect(rx).toBe(1536);
    expect(tx).toBe(512);
    expect(si.networkStats).toHaveBeenCalledOnce();
  });

  it('start a fresh read once the previous one has settled', async () => {
    mockNetworkStats([{ rx_sec: 1, tx_sec: 1 }]);
    await networkRxPlugin.collect();
    mockNetworkStats([{ rx_sec: 2, tx_sec: 2 }]);

    expect(await networkRxPlugin.collect()).toBe(2);
    expect(si.networkStats).toHaveBeenCalledTimes(2);
  });

  it('return null on the first poll, before systeminformation has a rate', async () => {
    mockNetworkStats([{ rx_sec: null, tx_sec: null }]);

    expect(await networkRxPlugin.collect()).toBeNull();
    expect(await networkTxPlugin.collect()).toBeNull();
  });

  it('return null when no interface is reported', async () => {
    mockNetworkStats([]);

    expect(await networkRxPlugin.collect()).toBeNull();
  });

  it('return null for a negative rate (counter reset)', async () => {
    mockNetworkStats([{ rx_sec: -1, tx_sec: -1 }]);

    expect(await networkRxPlugin.collect()).toBeNull();
  });
});

describe('diskUsedPlugin', () => {
  it('reports the use percentage of the root filesystem', async () => {
    vi.mocked(si.fsSize).mockResolvedValue([
      { mount: '/boot/firmware', use: 12.5 },
      { mount: '/', use: 43.2 }
    ] as never);

    expect(await diskUsedPlugin.collect()).toBe(43.2);
  });

  it('returns null when the root filesystem is not listed', async () => {
    vi.mocked(si.fsSize).mockResolvedValue([{ mount: '/data', use: 80 }] as never);

    expect(await diskUsedPlugin.collect()).toBeNull();
  });
});

describe('cpuTemperaturePlugin', () => {
  it('reports the main CPU temperature in °C', async () => {
    vi.mocked(si.cpuTemperature).mockResolvedValue({ main: 48.7 } as never);

    expect(await cpuTemperaturePlugin.collect()).toBe(48.7);
  });

  it('returns null when no sensor is available', async () => {
    vi.mocked(si.cpuTemperature).mockResolvedValue({ main: null } as never);

    expect(await cpuTemperaturePlugin.collect()).toBeNull();
  });

  it('returns null for the -1 sentinel some platforms report', async () => {
    vi.mocked(si.cpuTemperature).mockResolvedValue({ main: -1 } as never);

    expect(await cpuTemperaturePlugin.collect()).toBeNull();
  });
});

describe('loadPlugin', () => {
  it('reports the 1-minute load average', async () => {
    vi.spyOn(os, 'loadavg').mockReturnValue([0.42, 0.38, 0.35]);

    expect(await loadPlugin.collect()).toBe(0.42);
  });

  it('returns null on Windows, where Node always reports 0', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);

    expect(await loadPlugin.collect()).toBeNull();
  });

  it('is listed right after CPU load, so its chart sits beside it', async () => {
    const { builtinPlugins } = await import('../src/index.js');
    const ids = builtinPlugins.map((plugin) => plugin.id);

    expect(ids[ids.indexOf('cpu_load') + 1]).toBe('load_1');
  });
});
