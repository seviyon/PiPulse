import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer } from '../src/index.js';
import {
  APT_CACHE,
  APT_GET,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_MS,
  MANUAL_GAP_MS,
  MAX_LISTED,
  createUpdates,
  isFile,
  listsRefreshedAt,
  parsePolicy,
  parseSimulation,
  runApt,
  type Runner
} from '../src/updates.js';

// The text apt prints (LC_ALL=C), as documented in apt-get(8) and seen on Raspberry Pi OS.
const SIMULATION = `Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages have been kept back:
  linux-image-rpi-v8 raspi-firmware
  libcamera0
The following packages will be upgraded:
  libssl3 openssl pipulse
3 upgraded, 0 newly installed, 0 to remove and 3 not upgraded.
Inst libssl3 [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security [armhf])
Inst openssl [3.0.11-1~deb12u1] (3.0.11-1~deb12u2 Debian-Security:12/stable-security, Raspberry Pi Foundation:stable [armhf])
Inst pipulse [0.7.0] (0.7.1 PiPulse:stable [armhf])
Inst newdep (1.0 Debian:12/stable [armhf])
Conf libssl3 (3.0.11-1~deb12u2 Debian-Security:12/stable-security [armhf])
Conf openssl (3.0.11-1~deb12u2 Debian-Security:12/stable-security [armhf])
Conf pipulse (0.7.1 PiPulse:stable [armhf])
`;
const POLICY = `pipulse:
  Installed: 0.7.0
  Candidate: 0.7.1
  Version table:
     0.7.1 500
        500 https://seviyon.github.io/PiPulse/apt stable/main armhf Packages
 *** 0.7.0 100
        100 /var/lib/dpkg/status
`;
const NO_POLICY = `pipulse:
  Installed: (none)
  Candidate: (none)
  Version table:
`;

describe('parseSimulation', () => {
  it('lists what would be upgraded, with old and new versions, and what is kept back', () => {
    const result = parseSimulation(SIMULATION);
    expect(result.packages).toEqual([
      { name: 'libssl3', from: '3.0.11-1~deb12u1', to: '3.0.11-1~deb12u2' },
      { name: 'openssl', from: '3.0.11-1~deb12u1', to: '3.0.11-1~deb12u2' },
      { name: 'pipulse', from: '0.7.0', to: '0.7.1' }
    ]);
    expect(result.total).toBe(3);
    expect(result.keptBack).toEqual(['linux-image-rpi-v8', 'raspi-firmware', 'libcamera0']);
  });

  it('leaves out a package that would be newly installed, and says nothing for nothing', () => {
    expect(parseSimulation(SIMULATION).packages.map((p) => p.name)).not.toContain('newdep');
    expect(
      parseSimulation('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n')
    ).toEqual({
      packages: [],
      keptBack: [],
      total: 0
    });
  });

  it('ends the kept-back list at the next heading, and ignores text that is not a package name', () => {
    const result = parseSimulation(
      'The following packages have been kept back:\n  a b\nThe following packages will be upgraded:\n  c\nInst c [1] (2 x [armhf])\nInst ../evil [1] (2 x)\nInst BAD$name [1] (2 x)\n'
    );
    expect(result.keptBack).toEqual(['a', 'b']);
    expect(result.packages.map((p) => p.name)).toEqual(['c']);
  });

  it('counts a package once, and caps the list while keeping the exact total', () => {
    const many = Array.from(
      { length: MAX_LISTED + 25 },
      (_, i) => `Inst pkg${i} [1] (2 x [armhf])`
    );
    const result = parseSimulation([...many, 'Inst pkg0 [1] (2 x [armhf])'].join('\n'));
    expect(result.packages).toHaveLength(MAX_LISTED);
    expect(result.total).toBe(MAX_LISTED + 25);
  });
});

describe('parseSimulation on real Debian output', () => {
  // Captured from `LC_ALL=C apt-get -s -o Debug::NoLocking=1 upgrade` run as an unprivileged user on Debian bookworm.
  it('reads the lines apt really prints', () => {
    const real = `Reading package lists...
Calculating upgrade...
The following packages will be upgraded:
  libpcre2-8-0 tzdata
2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
Inst libpcre2-8-0 [10.42-1+deb12u1] (10.42-1+deb12u2 Debian-Security:12/oldstable-security [arm64])
Inst tzdata [2026b-0+deb12u1] (2026c-0+deb12u1 Debian-Security:12/oldstable-security [all])
Conf libpcre2-8-0 (10.42-1+deb12u2 Debian-Security:12/oldstable-security [arm64])
`;
    expect(parseSimulation(real)).toEqual({
      packages: [
        { name: 'libpcre2-8-0', from: '10.42-1+deb12u1', to: '10.42-1+deb12u2' },
        { name: 'tzdata', from: '2026b-0+deb12u1', to: '2026c-0+deb12u1' }
      ],
      keptBack: [],
      total: 2
    });
  });
});

describe('parsePolicy', () => {
  it('reads installed and candidate versions', () => {
    expect(parsePolicy(POLICY)).toEqual({ installed: '0.7.0', candidate: '0.7.1' });
  });
  it('treats (none) and odd text as no version', () => {
    expect(parsePolicy(NO_POLICY)).toEqual({ installed: null, candidate: null });
    expect(parsePolicy('  Installed: 1.0;rm -rf\n  Candidate: 2.0\n')).toEqual({
      installed: null,
      candidate: '2.0'
    });
    expect(parsePolicy('')).toEqual({ installed: null, candidate: null });
  });
});

function runner(answers: { sim?: string | Error; policy?: string | Error } = {}): Runner & {
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn = (async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    const answer = file === APT_GET ? (answers.sim ?? SIMULATION) : (answers.policy ?? POLICY);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as Runner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe('createUpdates', () => {
  let t = 1_000_000;
  let mono = 0;
  const make = (run: Runner, extra: object = {}) =>
    createUpdates({
      inContainer: false,
      run,
      now: () => t,
      monotonic: () => mono,
      listsRefreshedAt: () => 900_000,
      aptPresent: () => true,
      ...extra
    });

  it('starts pending, then reports PiPulse and the packages after a check', async () => {
    const run = runner();
    const updates = make(run);
    expect(updates.view()).toEqual({ state: 'pending' });
    const view = await updates.check();
    expect(view).toMatchObject({
      state: 'ok',
      checkedAt: 1_000_000,
      listsRefreshedAt: 900_000,
      pipulse: { source: 'apt', installed: '0.7.0', candidate: '0.7.1', available: true },
      os: { total: 3, keptBack: ['linux-image-rpi-v8', 'raspi-firmware', 'libcamera0'] }
    });
    expect(updates.view()).toBe(view);
    // fixed argv, by absolute path, no lock
    expect(run.calls).toEqual([
      [APT_GET, '-s', '-o', 'Debug::NoLocking=1', 'upgrade'],
      [APT_CACHE, 'policy', 'pipulse']
    ]);
  });

  it('says a tarball install is `other`, and that PiPulse is up to date when apt does not list it', async () => {
    const view = await make(
      runner({ sim: 'Inst openssl [1] (2 x [armhf])\n', policy: NO_POLICY })
    ).check();
    expect(view).toMatchObject({
      pipulse: { source: 'other', installed: null, candidate: null, available: false }
    });
    const noPolicy = await make(runner({ policy: new Error('no such package') })).check();
    expect(noPolicy).toMatchObject({ pipulse: { source: 'other' } });
  });

  it('counts a held-back PiPulse as available', async () => {
    const view = await make(
      runner({ sim: 'The following packages have been kept back:\n  pipulse\n' })
    ).check();
    expect(view).toMatchObject({ pipulse: { available: true } });
  });

  it('reports one line when apt fails, and tells onError', async () => {
    const errors: unknown[] = [];
    const view = await make(
      runner({
        sim: new Error(
          'Command failed: /usr/bin/apt-get -s upgrade\nE: Could not open /var/lib/dpkg/status\n'
        )
      }),
      { onError: (e: unknown) => errors.push(e) }
    ).check();
    expect(view).toEqual({ state: 'failed', checkedAt: 1_000_000, problem: 'E: Could not open …' });
    expect(errors).toHaveLength(1);
  });

  it('falls back to the first line, and to a word, for odd failures', async () => {
    const odd = await make(runner({ sim: new Error('spawn ETIMEDOUT') })).check();
    expect(odd).toMatchObject({ state: 'failed', problem: 'spawn ETIMEDOUT' });
    const text = await make(runner({ sim: 'x' as unknown as Error })).check(); // a non-Error answer is just output here
    expect(text.state).toBe('ok');
    const rejected = createUpdates({
      inContainer: false,
      aptPresent: () => true,
      run: async () => Promise.reject('plain string' as unknown as Error)
    });
    expect(await rejected.check()).toMatchObject({ state: 'failed', problem: 'plain string' });
    const empty = createUpdates({
      inContainer: false,
      aptPresent: () => true,
      run: async () => Promise.reject(new Error('\n'))
    });
    expect(await empty.check()).toMatchObject({ state: 'failed', problem: 'failed' });
  });

  it('runs nothing in a container, and says so', async () => {
    const run = runner();
    const updates = make(run, { inContainer: true });
    expect(updates.view()).toEqual({ state: 'unsupported', reason: 'container' });
    expect(await updates.check()).toEqual({ state: 'unsupported', reason: 'container' });
    updates.start();
    updates.stop();
    expect(run.calls).toEqual([]);
  });

  it('runs nothing without apt-get, and says so', async () => {
    const run = runner();
    const view = await make(run, { aptPresent: () => false }).check();
    expect(view).toEqual({ state: 'unsupported', reason: 'no-apt' });
    expect(run.calls).toEqual([]);
  });

  it('never runs two checks at once', async () => {
    let release!: () => void;
    const slow: Runner = vi.fn(
      (file) =>
        new Promise<string>((resolve) => {
          release = () => resolve(file === APT_GET ? SIMULATION : POLICY);
        })
    );
    const updates = make(slow);
    const first = updates.check();
    const second = updates.check();
    expect(second).toBe(first);
    release();
    await Promise.resolve();
    release();
    await first;
    expect(vi.mocked(slow).mock.calls.filter(([file]) => file === APT_GET)).toHaveLength(1);
  });

  it('answers a manual check from the last result when it finished moments ago', async () => {
    const run = runner();
    const updates = make(run);
    const first = await updates.check();
    mono += MANUAL_GAP_MS - 1;
    expect(await updates.check({ manual: true })).toBe(first);
    expect(run.calls).toHaveLength(2);
    mono += 2;
    t += 60_000;
    const again = await updates.check({ manual: true });
    expect(again).not.toBe(first);
    expect(run.calls).toHaveLength(4);
  });

  it('in a container nothing is ever run, even with the real runner', async () => {
    const updates = createUpdates({ inContainer: true });
    expect(await updates.check()).toEqual({ state: 'unsupported', reason: 'container' });
  });

  it('a manual check before any check runs one', async () => {
    const run = runner();
    const view = await make(run).check({ manual: true });
    expect(view.state).toBe('ok');
    expect(run.calls).toHaveLength(2);
  });

  describe('on a timer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('checks once after the first delay and then on the interval, until stopped', async () => {
      const run = runner();
      const updates = make(run, { firstCheckMs: 1000, intervalMs: 5000 });
      updates.start();
      updates.start(); // a second start changes nothing
      expect(run.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(run.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(run.calls).toHaveLength(4);
      updates.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(run.calls).toHaveLength(4);
    });

    it('with no options given, waits 2 minutes, then checks every 6 hours', async () => {
      const run = runner();
      const updates = createUpdates({ inContainer: false, run, aptPresent: () => true });
      updates.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
      expect(run.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(run.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(run.calls).toHaveLength(4);
      updates.stop();
      // the real clock and the real monotonic clock stamp the result
      expect(updates.view()).toMatchObject({ state: 'ok', checkedAt: expect.any(Number) });
    });

    it('stop before the first check cancels it', async () => {
      const run = runner();
      const updates = make(run, { firstCheckMs: 1000 });
      updates.start();
      updates.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(run.calls).toHaveLength(0);
    });
  });
});

describe('the real runner and the lists age', () => {
  it('runs a command with a fixed environment and rejects on failure', async () => {
    expect(await runApt('/bin/sh', ['-c', 'printf "%s" "$LC_ALL"'])).toBe('C');
    await expect(runApt('/bin/sh', ['-c', 'exit 3'])).rejects.toThrow();
    await expect(runApt('/nonexistent/apt-get', [])).rejects.toThrow();
  });

  it('reads the age of the lists without throwing where apt does not exist', () => {
    const value = listsRefreshedAt();
    expect(value === null || typeof value === 'number').toBe(true);
  });

  describe('the age of the package lists', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'pipulse-apt-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const at = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));

    it('is the daily stamp when there is one', () => {
      writeFileSync(join(dir, 'stamp'), '');
      at(join(dir, 'stamp'), 1_700_000_000_000);
      mkdirSync(join(dir, 'lists'));
      expect(listsRefreshedAt(join(dir, 'stamp'), join(dir, 'lists'))).toBe(1_700_000_000_000);
    });

    it('else the newest list file, ignoring the lock and partial downloads', () => {
      const lists = join(dir, 'lists');
      mkdirSync(lists);
      for (const [name, ms] of [
        ['a_Packages', 1_600_000_000_000],
        ['b_Packages', 1_650_000_000_000],
        ['lock', 1_900_000_000_000],
        ['partial', 1_900_000_000_000]
      ] as const) {
        writeFileSync(join(lists, name), '');
        at(join(lists, name), ms);
      }
      expect(listsRefreshedAt(join(dir, 'no-stamp'), lists)).toBe(1_650_000_000_000);
    });

    it('is unknown with no stamp and no lists', () => {
      expect(listsRefreshedAt(join(dir, 'no-stamp'), join(dir, 'no-lists'))).toBeNull();
      mkdirSync(join(dir, 'empty'));
      expect(listsRefreshedAt(join(dir, 'no-stamp'), join(dir, 'empty'))).toBeNull();
    });

    it('isFile tells a file from a folder and from nothing', () => {
      writeFileSync(join(dir, 'f'), '');
      expect(isFile(join(dir, 'f'))).toBe(true);
      expect(isFile(dir)).toBe(false);
      expect(isFile(join(dir, 'missing'))).toBe(false);
    });
  });

  it('with no options but a container flag it checks for the real apt-get on this machine', async () => {
    const updates = createUpdates({ inContainer: false, run: async () => '' });
    const view = await updates.check();
    expect(['ok', 'unsupported']).toContain(view.state);
  });
});

describe('/api/updates', () => {
  let db: PiPulseDb;
  let app: FastifyInstance | undefined;
  let passwordHash: PasswordHash;
  beforeAll(async () => {
    passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
  });
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    db.close();
  });
  const run = runner();
  const server = (extra: object = {}) => {
    app = buildServer(db, {
      auth: { failureDelayMs: 0, passwordHash },
      updates: createUpdates({ inContainer: false, run, aptPresent: () => true }),
      ...extra
    });
    return app;
  };
  const signIn = async (api: FastifyInstance) =>
    String(
      (await api.inject({ method: 'POST', url: '/api/login', payload: { password: 'secret' } }))
        .headers['set-cookie']
    ).split(';')[0]!;

  it('serves the current view to anyone (reads follow PIPULSE_PROTECT_READS)', async () => {
    const api = server();
    const res = await api.inject('/api/updates');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'pending' });
  });

  it('is hidden from a signed-out visitor when reads are protected', async () => {
    const api = server({ auth: { failureDelayMs: 0, passwordHash, protectReads: true } });
    expect((await api.inject('/api/updates')).statusCode).toBe(401);
  });

  it('a check needs a session: signed out is 401, signed in runs it and returns the view', async () => {
    const api = server();
    expect(
      (await api.inject({ method: 'POST', url: '/api/updates/check', payload: {} })).statusCode
    ).toBe(401);
    const cookie = await signIn(api);
    const res = await api.inject({
      method: 'POST',
      url: '/api/updates/check',
      headers: { cookie },
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'ok', os: { total: 3 } });
    expect((await api.inject('/api/updates')).json()).toMatchObject({ state: 'ok' });
  });

  it('a check from a foreign page is refused even when signed in', async () => {
    const api = server();
    const cookie = await signIn(api);
    const res = await api.inject({
      method: 'POST',
      url: '/api/updates/check',
      headers: { cookie, origin: 'http://evil.example', host: 'io.lan:8889' },
      payload: {}
    });
    expect(res.statusCode).toBe(403);
  });

  it('says "not available here" when the server has no updates support', async () => {
    app = buildServer(db, { auth: { failureDelayMs: 0, passwordHash } });
    expect((await app.inject('/api/updates')).json()).toEqual({
      state: 'unsupported',
      reason: 'no-apt'
    });
    const cookie = String(
      (await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'secret' } }))
        .headers['set-cookie']
    ).split(';')[0]!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/updates/check',
      headers: { cookie },
      payload: {}
    });
    expect(res.json()).toEqual({ state: 'unsupported', reason: 'no-apt' });
  });
});
