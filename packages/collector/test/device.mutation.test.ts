import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const closed: number[] = [];
const opened: number[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: ((...args: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...args);
      opened.push(fd);
      return fd;
    }) as typeof real.openSync,
    closeSync: ((fd: number) => {
      closed.push(fd);
      return real.closeSync(fd);
    }) as typeof real.closeSync
  };
});

vi.mock('systeminformation', () => ({
  default: { system: vi.fn(), osInfo: vi.fn(), mem: vi.fn() }
}));

const si = (await import('systeminformation')).default;
const os = (await import('node:os')).default;
const { hostOverrides, readDeviceInfo } = await import('../src/index.js');

afterEach(() => {
  closed.length = 0;
  opened.length = 0;
  vi.restoreAllMocks();
});

function hostWith(files: { osRelease?: string; model?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-host-'));
  mkdirSync(join(root, 'etc'));
  if (files.osRelease !== undefined) writeFileSync(join(root, 'etc/os-release'), files.osRelease);
  if (files.model !== undefined) writeFileSync(join(root, 'model'), files.model);
  return root;
}

describe('hostOverrides reading', () => {
  it('closes every file it opens', () => {
    hostOverrides(hostWith({ osRelease: 'PRETTY_NAME="X"\n', model: 'Pi' }));
    expect(opened).toHaveLength(2);
    expect(closed.sort()).toEqual(opened.sort());
  });

  it.each([
    ['unquoted', 'PRETTY_NAME=Debian 12\n', 'Debian 12'],
    ['on a later line', 'NAME="x"\nPRETTY_NAME="Debian 12"\nID=debian\n', 'Debian 12'],
    ['at the end, no newline', 'PRETTY_NAME="Debian 12"', 'Debian 12']
  ])('takes the name when it is %s', (_, osRelease, os) => {
    expect(hostOverrides(hostWith({ osRelease }))).toStrictEqual({ os });
  });

  it.each([
    ['another key that ends in PRETTY_NAME', 'FAKE_PRETTY_NAME="wrong"\n'],
    ['text after the closing quote', 'PRETTY_NAME="a"b\n'],
    ['no such line', 'NAME="Debian"\n'],
    ['a quote that is never closed', 'PRETTY_NAME="Debian 12\n'],
    ['an empty name', 'PRETTY_NAME=""\n']
  ])('leaves the OS out for %s', (_, osRelease) => {
    expect(hostOverrides(hostWith({ osRelease }))).toStrictEqual({});
  });

  it('trims the model and drops its NUL', () => {
    expect(hostOverrides(hostWith({ model: ' Pi 5\n\0' }))).toStrictEqual({ model: 'Pi 5' });
  });

  it('leaves out a model that is only NULs and blanks', () => {
    expect(hostOverrides(hostWith({ model: ' \0\n' }))).toStrictEqual({});
  });
});

describe('readDeviceInfo', () => {
  function mockSi(osInfo: Record<string, unknown>) {
    vi.mocked(si.system).mockResolvedValue({ model: 'Pi 2' } as never);
    vi.mocked(si.mem).mockResolvedValue({ total: 2 ** 20 * 1234.5678 } as never);
    vi.mocked(si.osInfo).mockResolvedValue({
      hostname: 'io',
      platform: 'linux',
      arch: 'arm',
      kernel: '6.1.0',
      distro: 'Raspbian GNU/Linux',
      release: '11',
      codename: '',
      ...osInfo
    } as never);
    vi.spyOn(os, 'cpus').mockReturnValue(new Array(4).fill({}) as never);
  }

  it('reports the device, with the codename in brackets after the release', async () => {
    mockSi({ codename: 'bullseye' });
    expect(await readDeviceInfo()).toStrictEqual({
      hostname: 'io',
      platform: 'linux',
      arch: 'arm',
      model: 'Pi 2',
      os: 'Raspbian GNU/Linux 11 (bullseye)',
      kernel: '6.1.0',
      memoryTotalMb: 1234.57,
      cpus: 4
    });
  });

  it('leaves out a missing codename without a stray space', async () => {
    mockSi({ codename: '' });
    expect((await readDeviceInfo()).os).toBe('Raspbian GNU/Linux 11');
  });

  it("puts the host's files over what si found, only when a host root is given", async () => {
    mockSi({});
    const hostRoot = hostWith({ osRelease: 'PRETTY_NAME="Host OS"\n', model: 'Host Pi' });
    expect(await readDeviceInfo({ hostRoot })).toMatchObject({ os: 'Host OS', model: 'Host Pi' });
    expect(await readDeviceInfo({})).toMatchObject({ model: 'Pi 2' });
  });
});
