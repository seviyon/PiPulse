import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('systeminformation', () => ({
  default: {
    currentLoad: vi.fn(),
    mem: vi.fn(),
    fsSize: vi.fn(),
    cpuTemperature: vi.fn(),
    cpuCurrentSpeed: vi.fn(),
    networkStats: vi.fn()
  }
}));

const si = (await import('systeminformation')).default;
const {
  builtinPlugins,
  bootUsedPlugin,
  cpuFrequencyPlugin,
  cpuLoadPlugin,
  cpuTemperaturePlugin,
  diskUsedPlugin,
  loadPlugin,
  memoryUsedPlugin,
  swapUsedPlugin
} = await import('../src/index.js');

afterEach(() => {
  vi.resetAllMocks();
});

describe('the built-in plugins as the dashboard and the API see them', () => {
  it('keep their id, label, unit and interval', () => {
    expect(
      builtinPlugins.map(({ id, label, unit, intervalMs }) => [id, label, unit, intervalMs])
    ).toEqual([
      ['cpu_load', 'CPU load', '%', 5000],
      ['load_1', 'Load (1 min)', '', 30000],
      ['cpu_temperature', 'CPU temperature', '°C', 10000],
      ['cpu_frequency', 'CPU frequency', 'MHz', 10000],
      ['cpu_voltage', expect.any(String), expect.any(String), expect.any(Number)],
      ['throttled', expect.any(String), expect.any(String), expect.any(Number)],
      ['memory_used', 'Memory used', 'MB', 5000],
      ['swap_used', 'Swap used', '%', 10000],
      ['swap_io', expect.any(String), expect.any(String), expect.any(Number)],
      ['disk_used', 'Disk used (/)', '%', 60000],
      ['boot_used', 'Disk used (/boot)', '%', 60000],
      ['network_rx', 'Network received', 'B/s', 5000],
      ['network_tx', 'Network sent', 'B/s', 5000]
    ]);
  });
});

describe('readings', () => {
  it('cpu_load is the current load', async () => {
    vi.mocked(si.currentLoad).mockResolvedValue({ currentLoad: 12.5 } as never);
    expect(await cpuLoadPlugin.collect()).toBe(12.5);
  });

  it('memory_used is the active memory in MB, rounded to two decimals', async () => {
    vi.mocked(si.mem).mockResolvedValue({ active: 2 ** 20 * 1234.5678 } as never);
    expect(await memoryUsedPlugin.collect()).toBe(1234.57);
  });

  it('load_1 is the one-minute load average, and null if the platform reports none', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(os, 'loadavg').mockReturnValue([0.42, 1, 2]);
    expect(await loadPlugin.collect()).toBe(0.42);
    vi.spyOn(os, 'loadavg').mockReturnValue([]);
    expect(await loadPlugin.collect()).toBeNull();
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);
    expect(await loadPlugin.collect()).toBeNull();
  });

  it('swap_used is a percentage, and null when there is no swap', async () => {
    vi.mocked(si.mem).mockResolvedValue({ swaptotal: 400, swapused: 100 } as never);
    expect(await swapUsedPlugin.collect()).toBe(25);
    vi.mocked(si.mem).mockResolvedValue({ swaptotal: 0, swapused: 0 } as never);
    expect(await swapUsedPlugin.collect()).toBeNull();
  });

  it('cpu_frequency is MHz, and null when si could not read the clock', async () => {
    vi.mocked(si.cpuCurrentSpeed).mockResolvedValue({ avg: 1.2345 } as never);
    expect(await cpuFrequencyPlugin.collect()).toBe(1235);
    vi.mocked(si.cpuCurrentSpeed).mockResolvedValue({ avg: 0 } as never);
    expect(await cpuFrequencyPlugin.collect()).toBeNull();
  });

  it('boot_used reads /boot, or /boot/firmware, and nothing else', async () => {
    const fs = (mount: string, use: number) => ({ mount, use });
    vi.mocked(si.fsSize).mockResolvedValue([fs('/', 50), fs('/boot', 21)] as never);
    expect(await bootUsedPlugin.collect()).toBe(21);
    vi.mocked(si.fsSize).mockResolvedValue([fs('/', 50), fs('/boot/firmware', 22)] as never);
    expect(await bootUsedPlugin.collect()).toBe(22);
    vi.mocked(si.fsSize).mockResolvedValue([fs('/', 50), fs('/mnt', 30)] as never);
    expect(await bootUsedPlugin.collect()).toBeNull();
  });
});

describe('a reading that is not a real, non-negative number is null', () => {
  const disk = (use: unknown) =>
    vi.mocked(si.fsSize).mockResolvedValue([{ mount: '/', use }] as never);

  it.each([-1, NaN, Infinity, -Infinity, '5', null, undefined])('%j', async (use) => {
    disk(use);
    expect(await diskUsedPlugin.collect()).toBeNull();
  });

  it('but 0 is a reading', async () => {
    disk(0);
    expect(await diskUsedPlugin.collect()).toBe(0);
  });

  it('applies to the temperature too', async () => {
    vi.mocked(si.cpuTemperature).mockResolvedValue({ main: Infinity } as never);
    expect(await cpuTemperaturePlugin.collect()).toBeNull();
    vi.mocked(si.cpuTemperature).mockResolvedValue({ main: 0 } as never);
    expect(await cpuTemperaturePlugin.collect()).toBe(0);
  });
});
