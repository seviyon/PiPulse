import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('systeminformation', () => ({
  default: {
    mem: vi.fn(),
    fsSize: vi.fn(),
    cpuCurrentSpeed: vi.fn(),
    system: vi.fn(),
    osInfo: vi.fn()
  }
}));

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const si = (await import('systeminformation')).default;
const { execFile } = await import('node:child_process');
const {
  swapUsedPlugin,
  bootUsedPlugin,
  cpuFrequencyPlugin,
  cpuVoltagePlugin,
  throttledPlugin,
  readDeviceInfo
} = await import('../src/index.js');

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** Makes `vcgencmd <args>` print `output`, or fail with `error`. */
function mockVcgencmd(outputs: Record<string, string | NodeJS.ErrnoException>) {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: ExecCallback
  ) => {
    const result = outputs[args.join(' ')];
    if (file !== 'vcgencmd' || result === undefined) {
      callback(new Error(`unexpected command ${file} ${args.join(' ')}`), '', '');
    } else if (result instanceof Error) {
      callback(result, '', (result as { stderr?: string }).stderr ?? '');
    } else {
      callback(null, result, '');
    }
  }) as never);
}

/** vcgencmd exiting non-zero because it can't open the firmware interface. */
function noVchiq(): NodeJS.ErrnoException {
  return Object.assign(new Error('Command failed: vcgencmd'), {
    code: 255 as unknown as string,
    stderr: '* failed to open vchiq instance\n'
  });
}

function eacces(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn vcgencmd EACCES'), { code: 'EACCES' });
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn vcgencmd ENOENT'), { code: 'ENOENT' });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('swapUsedPlugin', () => {
  it('reports swap in use as a percentage of total swap', async () => {
    vi.mocked(si.mem).mockResolvedValue({
      swaptotal: 100 * 2 ** 20,
      swapused: 81.04 * 2 ** 20
    } as never);
    expect(await swapUsedPlugin.collect()).toBeCloseTo(81.04, 2);
  });

  it('returns null on a system without swap', async () => {
    vi.mocked(si.mem).mockResolvedValue({ swaptotal: 0, swapused: 0 } as never);
    expect(await swapUsedPlugin.collect()).toBeNull();
  });
});

describe('bootUsedPlugin', () => {
  it.each(['/boot', '/boot/firmware'])('reports the use percentage of %s', async (mount) => {
    vi.mocked(si.fsSize).mockResolvedValue([
      { mount: '/', use: 54.7 },
      { mount, use: 19.92 }
    ] as never);
    expect(await bootUsedPlugin.collect()).toBe(19.92);
  });

  it('returns null when there is no separate boot partition', async () => {
    vi.mocked(si.fsSize).mockResolvedValue([{ mount: '/', use: 54.7 }] as never);
    expect(await bootUsedPlugin.collect()).toBeNull();
  });
});

describe('cpuFrequencyPlugin', () => {
  it('reports the current CPU clock in MHz', async () => {
    vi.mocked(si.cpuCurrentSpeed).mockResolvedValue({ avg: 0.6 } as never);
    expect(await cpuFrequencyPlugin.collect()).toBe(600);
  });

  it('returns null when the clock is unknown', async () => {
    vi.mocked(si.cpuCurrentSpeed).mockResolvedValue({ avg: 0 } as never);
    expect(await cpuFrequencyPlugin.collect()).toBeNull();
  });
});

describe('cpuVoltagePlugin', () => {
  it('parses `vcgencmd measure_volts` (real output from the Pi)', async () => {
    mockVcgencmd({ measure_volts: 'volt=1.2000V\n' });
    expect(await cpuVoltagePlugin.collect()).toBe(1.2);
  });

  it('returns null on a machine without vcgencmd', async () => {
    mockVcgencmd({ measure_volts: enoent() });
    expect(await cpuVoltagePlugin.collect()).toBeNull();
  });

  it('rejects output it cannot parse, so the failure is reported', async () => {
    mockVcgencmd({ measure_volts: 'VCHI initialization failed\n' });
    await expect(cpuVoltagePlugin.collect()).rejects.toThrow(/unexpected vcgencmd output/);
  });
});

describe('throttledPlugin', () => {
  it.each([
    ['throttled=0x0\n', 0],
    ['throttled=0x50005\n', 0x50005]
  ])('parses %j as the raw throttle bitmask', async (output, bits) => {
    mockVcgencmd({ get_throttled: output });
    expect(await throttledPlugin.collect()).toBe(bits);
  });

  it('returns null on a machine without vcgencmd', async () => {
    mockVcgencmd({ get_throttled: enoent() });
    expect(await throttledPlugin.collect()).toBeNull();
  });
});

describe('readDeviceInfo', () => {
  it('describes the board, OS, kernel and memory', async () => {
    vi.mocked(si.system).mockResolvedValue({ model: 'Raspberry Pi 3 Model B Rev 1.2' } as never);
    vi.mocked(si.osInfo).mockResolvedValue({
      hostname: 'Io',
      platform: 'linux',
      arch: 'arm',
      distro: 'Raspbian GNU/Linux',
      release: '11',
      codename: 'bullseye',
      kernel: '6.1.21-v7+'
    } as never);
    vi.mocked(si.mem).mockResolvedValue({ total: 971.52 * 2 ** 20 } as never);
    vi.spyOn(os, 'cpus').mockReturnValue(new Array(4).fill({}) as never);

    const device = await readDeviceInfo();

    expect(device).toMatchObject({
      hostname: 'Io',
      platform: 'linux',
      arch: 'arm',
      model: 'Raspberry Pi 3 Model B Rev 1.2',
      os: 'Raspbian GNU/Linux 11 (bullseye)',
      kernel: '6.1.21-v7+',
      memoryTotalMb: 971.52,
      cpus: 4
    });
  });
});

// Each plugin reports an unusable vcgencmd once per process, so each case
// below uses a plugin no other test has driven down that path.
describe('vcgencmd that cannot reach the firmware', () => {
  it('reports it once, with the fix, then goes quiet instead of failing every poll', async () => {
    mockVcgencmd({ get_throttled: noVchiq() });

    await expect(throttledPlugin.collect()).rejects.toThrow(/failed to open vchiq.*"video" group/s);
    await expect(throttledPlugin.collect()).resolves.toBeNull();
    await expect(throttledPlugin.collect()).resolves.toBeNull();
  });

  it('treats a vcgencmd the user may not execute the same way', async () => {
    mockVcgencmd({ measure_volts: eacces() });

    await expect(cpuVoltagePlugin.collect()).rejects.toThrow(/"video" group/);
    await expect(cpuVoltagePlugin.collect()).resolves.toBeNull();
  });

  it('still reports every timeout, since those can recover', async () => {
    const timeout = () =>
      Object.assign(new Error('Command failed: vcgencmd'), { killed: true, signal: 'SIGTERM' });
    mockVcgencmd({ get_throttled: timeout() });

    await expect(throttledPlugin.collect()).rejects.toThrow('Command failed');
    await expect(throttledPlugin.collect()).rejects.toThrow('Command failed');
  });
});
