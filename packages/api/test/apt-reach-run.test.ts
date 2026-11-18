import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const { execFile } = await import('node:child_process');
const { runReach } = await import('../src/apt-reach.js');

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

/** Makes the next apt-get run end with `error` (or none) and print `stdout`. */
const answer = (error: Error | null, stdout: string) =>
  vi
    .mocked(execFile)
    .mockImplementationOnce(((_file: string, _args: string[], _options: unknown, cb: Callback) =>
      cb(error, stdout, '')) as never);

describe('runReach', () => {
  it('runs /usr/bin/apt-get by its path, killed outright after a minute, with a fixed environment', async () => {
    answer(null, 'out');
    await runReach(['update']);
    expect(vi.mocked(execFile)).toHaveBeenLastCalledWith(
      '/usr/bin/apt-get',
      ['update'],
      {
        timeout: 60_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }
      },
      expect.any(Function)
    );
  });

  it('resolves what apt printed', async () => {
    answer(null, 'Get:1 http://a/x y InRelease\n');
    expect(await runReach(['update'])).toBe('Get:1 http://a/x y InRelease\n');
  });

  it('still resolves what apt printed when it exits non-zero (a bad signature exits 100)', async () => {
    answer(
      Object.assign(new Error('Command failed'), { code: 100 }),
      'Err:1 http://a/x y InRelease\n'
    );
    expect(await runReach(['update'])).toBe('Err:1 http://a/x y InRelease\n');
  });

  it('rejects when it was killed (the time limit), because nothing it printed can be trusted', async () => {
    const killed = Object.assign(new Error('timed out'), { killed: true });
    answer(killed, 'Get:1 http://a/x y InRelease\n');
    await expect(runReach(['update'])).rejects.toBe(killed);
  });

  it('rejects a launch failure, a signal and a full output buffer, whatever they printed', async () => {
    for (const error of [
      Object.assign(new Error('spawn apt-get EACCES'), { code: 'EACCES' }),
      Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      Object.assign(new Error('terminated'), { code: null, signal: 'SIGTERM' }),
      Object.assign(new Error('terminated'), { code: 100, signal: 'SIGSEGV' })
    ]) {
      answer(error, 'Get:1 http://a/x y InRelease\n');
      await expect(runReach(['update'])).rejects.toBe(error);
    }
  });

  it('rejects when apt-get is not there', async () => {
    const missing = Object.assign(new Error('spawn apt-get ENOENT'), { code: 'ENOENT' });
    answer(missing, '');
    await expect(runReach(['update'])).rejects.toBe(missing);
  });
});
