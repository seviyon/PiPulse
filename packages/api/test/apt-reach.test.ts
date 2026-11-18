import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkReach, parseReach, reachArgs } from '../src/apt-reach.js';
import { createUpdates, type Reach } from '../src/updates.js';

// Output of `LC_ALL=C apt-get update` with the options of reachArgs, from real runs on Debian 11
// (apt 2.2.4) and Debian 12 (apt 2.6.2); the two print the same lines. The trailing "rm:" line is
// a container's own hook and is deliberately left in.
const REAL = `Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]
Get:2 http://deb.debian.org/debian bookworm-updates InRelease [55.4 kB]
Get:3 http://deb.debian.org/debian-security bookworm-security InRelease [34.8 kB]
rm: cannot remove '/var/cache/apt/archives/partial/*.deb': Permission denied
Fetched 241 kB in 1s (232 kB/s)
Reading package lists...
`;
const OFFLINE = `Err:1 http://127.0.0.1:8009 x InRelease
  Could not connect to 127.0.0.1:8009 (127.0.0.1). - connect (111: Connection refused)
Reading package lists...
W: Failed to fetch http://127.0.0.1:8009/dists/x/InRelease  Could not connect
W: Some index files failed to download. They have been ignored, or old ones used instead.
`;
const MIXED = `Get:1 http://127.0.0.1:8001 x InRelease [1636 B]
Err:2 http://127.0.0.1:8009 x InRelease
  Could not connect to 127.0.0.1:8009 (127.0.0.1). - connect (111: Connection refused) [IP: 127.0.0.1 8001]
Fetched 1636 B in 0s (37.4 kB/s)
Reading package lists...
W: Failed to fetch http://127.0.0.1:8009/dists/x/InRelease  Could not connect
`;
// Fetched, then refused: apt prints Get:N and Err:N for the same source, and exits 100.
const BAD_SIGNATURE = `Get:1 http://127.0.0.1:8001 x InRelease [1636 B]
Get:2 http://127.0.0.1:8002 x InRelease [1636 B]
Err:2 http://127.0.0.1:8002 x InRelease
  The following signatures couldn't be verified because the public key is not available: NO_PUBKEY 4DFBFDA0096D6425
Reading package lists...
W: GPG error: http://127.0.0.1:8002 x InRelease: The following signatures couldn't be verified
E: The repository 'http://127.0.0.1:8002 x InRelease' is not signed.
`;

describe('parseReach', () => {
  it('ok when every source answered with signed metadata', () => {
    expect(parseReach(REAL)).toEqual({ state: 'ok', reached: 3, total: 3 });
  });

  it('counts a Hit as reached too', () => {
    expect(parseReach('Hit:1 http://a/x y InRelease\n')).toEqual({
      state: 'ok',
      reached: 1,
      total: 1
    });
  });

  it('failed when none answered, although apt exited 0', () => {
    expect(parseReach(OFFLINE)).toEqual({ state: 'failed', reached: 0, total: 1 });
  });

  it('partial when one source is down and another works', () => {
    expect(parseReach(MIXED)).toEqual({ state: 'partial', reached: 1, total: 2 });
  });

  it('a signature that did not verify is not reached, even after its Get line', () => {
    expect(parseReach(BAD_SIGNATURE)).toEqual({ state: 'partial', reached: 1, total: 2 });
    expect(
      parseReach(
        BAD_SIGNATURE.replace(/^Get:1.*\n/, '')
          .replace('Get:2', 'Get:1')
          .replace(/:2 /g, ':1 ')
      ).state
    ).toBe('failed');
  });

  it('a source apt ignored is not reached', () => {
    expect(
      parseReach('Ign:1 http://a/x y InRelease\nGet:2 http://b/x y InRelease [1 B]\n')
    ).toEqual({
      state: 'partial',
      reached: 1,
      total: 2
    });
  });

  it('counts the metadata of each source once, whatever else apt prints', () => {
    const text =
      'Get:1 http://a/x y InRelease [1 B]\nGet:2 http://a/x y/main arm64 Packages [9 B]\nErr:3 http://a/x y/main arm64 Contents\n';
    expect(parseReach(text)).toEqual({ state: 'ok', reached: 1, total: 1 });
  });

  it('no-sources when apt has nothing to ask', () => {
    expect(parseReach('Reading package lists...\n')).toEqual({
      state: 'no-sources',
      reached: 0,
      total: 0
    });
    expect(parseReach('')).toEqual({ state: 'no-sources', reached: 0, total: 0 });
  });

  it('carries no address or text from apt', () => {
    expect(JSON.stringify(parseReach(MIXED))).not.toMatch(/127|http|Could not/);
  });
});

describe('a source that falls back to Release', () => {
  const missing = `Err:1 http://a/x y InRelease
  404  Not Found
Err:2 http://a/x y Release
  404  Not Found
Err:3 http://a/x y Release.gpg
  404  Not Found
`;
  it('is one source, however many lines apt prints for it', () => {
    expect(parseReach(missing)).toEqual({ state: 'failed', reached: 0, total: 1 });
  });

  it('is reached when Release and its signature both come through', () => {
    const legacy =
      'Err:1 http://a/x y InRelease\n  404\nGet:2 http://a/x y Release [1 B]\nGet:3 http://a/x y Release.gpg [1 B]\n';
    expect(parseReach(legacy)).toEqual({ state: 'ok', reached: 1, total: 1 });
  });

  it('is not reached when the Release signature fails', () => {
    const legacy =
      'Err:1 http://a/x y InRelease\n  404\nGet:2 http://a/x y Release [1 B]\nGet:3 http://a/x y Release.gpg [1 B]\nErr:3 http://a/x y Release.gpg\n  bad\n';
    expect(parseReach(legacy).state).toBe('failed');
  });
});

describe('a URL or suite that contains the word Release', () => {
  it('is still one source, read by its last word', () => {
    expect(parseReach('Get:1 http://mirror/Release x y InRelease [1 B]\n')).toEqual({
      state: 'ok',
      reached: 1,
      total: 1
    });
    expect(parseReach('Err:1 http://mirror/Release x y InRelease\n  404\n')).toEqual({
      state: 'failed',
      reached: 0,
      total: 1
    });
    expect(parseReach('Get:1 http://mirror/Release/ y InRelease [1 B]\n').state).toBe('ok');
  });
});

describe('reachArgs', () => {
  it('asks for InRelease only, into the private folder, with short timeouts and no retries', () => {
    const args = reachArgs('/tmp/d');
    expect(args[0]).toBe('update');
    expect(args).toContain('-oDir::State::lists=/tmp/d/lists');
    expect(args).toContain('-oDir::Cache=/tmp/d/cache');
    expect(args).toContain('-oAcquire::IndexTargets::deb::Packages::DefaultEnabled=false');
    expect(args).toContain('-oAcquire::Languages=none');
    // neither the binary indexes nor a deb-src line's Sources index is fetched
    expect(args).toContain('-oAcquire::IndexTargets::deb-src::Sources::DefaultEnabled=false');
    // a host's own quiet setting must not hide the lines that are read
    expect(args).toContain('-oquiet=1');
    expect(args).toContain('-oAPT::Quiet=1');
    expect(args).toContain('-oAcquire::Retries=0');
    expect(args).toContain('-oDebug::NoLocking=1');
    expect(args).toContain('-oAPT::Get::List-Cleanup=0');
    expect(args.join(' ')).not.toContain('/var/lib/apt');
  });
});

describe('checkReach', () => {
  const folderOf = (args: string[]) =>
    args
      .find((a) => a.startsWith('-oDir::Cache='))!
      .slice('-oDir::Cache='.length)
      .replace(/\/cache$/, '');

  it('hands apt a prepared private folder and removes it after a good run', async () => {
    let dir = '';
    const result = await checkReach(async (args) => {
      dir = folderOf(args);
      expect(existsSync(`${dir}/lists/partial`)).toBe(true);
      expect(existsSync(`${dir}/cache/archives/partial`)).toBe(true);
      return REAL;
    });
    expect(result.state).toBe('ok');
    expect(existsSync(dir)).toBe(false);
  });

  it('removes it when apt cannot be run or overruns its time', async () => {
    let dir = '';
    await expect(
      checkReach(async (args) => {
        dir = folderOf(args);
        throw new Error('timed out');
      })
    ).rejects.toThrow('timed out');
    expect(dir).not.toBe('');
    expect(existsSync(dir)).toBe(false);
  });
});

describe('reach in the updates view', () => {
  const run = async (_file: string, args: string[]) => (args.includes('policy') ? '' : '');
  const make = (
    steps: Array<() => Promise<{ state: never; reached: number; total: number }> | never>,
    clock: { t: number }
  ) => {
    let i = 0;
    return createUpdates({
      inContainer: false,
      run,
      aptPresent: () => true,
      now: () => clock.t,
      listsRefreshedAt: () => null,
      reach: () => (steps[i++] as () => Promise<never>)()
    });
  };
  const reachOf = (view: unknown) => (view as { reach: Reach }).reach;

  it('keeps the last good time beside a later failure, and shows the failure', async () => {
    const clock = { t: 1000 };
    const updates = make(
      [
        async () => ({ state: 'ok', reached: 2, total: 2 }) as never,
        async () => ({ state: 'failed', reached: 0, total: 2 }) as never,
        async () => ({ state: 'partial', reached: 1, total: 2 }) as never
      ],
      clock
    );
    expect(reachOf(await updates.check())).toEqual({
      state: 'ok',
      attemptedAt: 1000,
      succeededAt: 1000,
      reached: 2,
      total: 2
    });
    clock.t = 2000;
    expect(reachOf(await updates.check())).toEqual({
      state: 'failed',
      attemptedAt: 2000,
      succeededAt: 1000,
      reached: 0,
      total: 2
    });
    clock.t = 3000;
    expect(reachOf(await updates.check())).toEqual({
      state: 'partial',
      attemptedAt: 3000,
      succeededAt: 1000,
      reached: 1,
      total: 2
    });
  });

  it('a probe that cannot run is a failed attempt, and the update list still shows', async () => {
    const clock = { t: 5000 };
    const errors: unknown[] = [];
    const updates = createUpdates({
      inContainer: false,
      run,
      aptPresent: () => true,
      now: () => clock.t,
      listsRefreshedAt: () => null,
      reach: async () => {
        throw new Error('spawn failed');
      },
      onError: (e) => errors.push(e)
    });
    const view = await updates.check();
    expect(view.state).toBe('ok');
    expect(reachOf(view)).toEqual({
      state: 'failed',
      attemptedAt: 5000,
      succeededAt: null,
      reached: 0,
      total: 0
    });
    expect(errors).toHaveLength(1);
  });

  it('a manual check asks again once the 30 s gap has passed', async () => {
    let asked = 0;
    let mono = 0;
    const updates = createUpdates({
      inContainer: false,
      run,
      aptPresent: () => true,
      listsRefreshedAt: () => null,
      monotonic: () => mono,
      reach: async () => (asked++, { state: 'ok', reached: 1, total: 1 })
    });
    await updates.check();
    mono = 10_000;
    await updates.check({ manual: true });
    expect(asked).toBe(1);
    mono = 40_000;
    await updates.check({ manual: true });
    expect(asked).toBe(2);
  });
});
