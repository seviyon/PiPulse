import { readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Layout } from '../src/layout.js';
import {
  BREAK_MUTEX_STALE_MS,
  LOCK_FILE,
  LockError,
  breakLock,
  localIdentity,
  withLock,
  type LockHolder,
  type LocalIdentity
} from '../src/lock.js';
import { tempDir } from './helpers.js';

// Tests written against the survivors of a mutation run over the breaker turns and the wait loop.
const hooks = vi.hoisted(() => ({
  readdirViews: [] as string[][],
  writeError: undefined as string | undefined,
  closeCalls: 0,
  fsyncCalls: 0,
  lockStatFailsOnce: false
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) =>
      hooks.readdirViews.shift() ?? actual.readdirSync(...args),
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (hooks.writeError) {
        throw Object.assign(new Error(hooks.writeError), { code: hooks.writeError });
      }
      return actual.writeSync(...args);
    },
    closeSync: (fd: number) => {
      hooks.closeCalls += 1;
      return actual.closeSync(fd);
    },
    fsyncSync: (fd: number) => {
      hooks.fsyncCalls += 1;
      return actual.fsyncSync(fd);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (hooks.lockStatFailsOnce && String(args[0]).endsWith(LOCK_FILE)) {
        hooks.lockStatFailsOnce = false;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return actual.statSync(...args);
    }
  };
});

let dir: string;
let layout: Layout;
beforeEach(() => {
  dir = tempDir();
  layout = {
    tlsDir: dir,
    caRoot: dir,
    uid: process.getuid!(),
    gid: process.getgid!(),
    privateGid: process.getgid!()
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  hooks.readdirViews = [];
  hooks.writeError = undefined;
  hooks.closeCalls = 0;
  hooks.fsyncCalls = 0;
  hooks.lockStatFailsOnce = false;
  rmSync(dir, { recursive: true, force: true });
});

const lockPath = () => join(dir, LOCK_FILE);
const gen = (n: number) => `${lockPath()}.breaking.${n}`;
const gens = () =>
  readdirSync(dir)
    .filter((name) => /\.breaking\.\d+$/.test(name))
    .map((name) => Number(name.slice(name.lastIndexOf('.') + 1)))
    .sort((a, b) => a - b);
const writeLock = (over: Partial<LockHolder> = {}) =>
  writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 999_999,
      ...localIdentity(),
      startTime: null,
      token: 'dead',
      startedAt: Date.now(),
      ...over
    }),
    { mode: 0o600 }
  );
const stale = () => {
  writeLock();
  return JSON.parse(readFileSync(lockPath(), 'utf8')) as LockHolder;
};
const releasedTurn = (n: number) => writeFileSync(gen(n), JSON.stringify({ released: true }));
const owner = (n: number, over: Partial<LockHolder> = {}) =>
  writeFileSync(
    gen(n),
    JSON.stringify({
      pid: 999_999,
      ...localIdentity(),
      startTime: null,
      token: `owner-${n}`,
      startedAt: Date.now(),
      ...over
    }),
    { mode: 0o600 }
  );
const at = (file: string, ms: number) => utimesSync(file, new Date(ms), new Date(ms));
const ident = (over: Partial<LocalIdentity> = {}): LocalIdentity => ({
  startTime: null,
  bootId: null,
  pidNs: null,
  host: 'here',
  ...over
});

describe('turn numbers', () => {
  it('reads only plain numbers after the prefix, and counts past one digit in numeric order', () => {
    const dead = stale();
    const base = basename(lockPath());
    releasedTurn(2);
    releasedTurn(9);
    releasedTurn(10);
    // Not turns: they sort after "10" and must not become the newest.
    for (const name of [`${base}.breaking.x1`, `${base}.breaking.1x`, `${base}.breaking.`]) {
      writeFileSync(join(dir, name), '');
    }
    writeFileSync(join(dir, 'z'.repeat(`${base}.breaking.`.length) + '7'), '');
    expect(breakLock(lockPath(), dead)).toBe('done');
    expect(gens()).toEqual([11]);
    expect(readdirSync(dir)).toEqual(
      expect.arrayContaining([`${base}.breaking.x1`, `${base}.breaking.1x`, `${base}.breaking.`])
    );
  });

  it('numbers after a single released turn that is two digits long', () => {
    const dead = stale();
    releasedTurn(10);
    expect(breakLock(lockPath(), dead)).toBe('done');
    expect(gens()).toEqual([11]);
  });

  it('takes over a newest turn whose file is gone by the time it is looked at', () => {
    const dead = stale();
    hooks.readdirViews.push([`${basename(lockPath())}.breaking.5`]);
    expect(breakLock(lockPath(), dead)).toBe('done');
    expect(gens()).toEqual([6]);
  });

  it('does not fail on older turns or stale copies that vanished after they were listed', () => {
    const base = basename(lockPath());
    hooks.readdirViews.push(
      [],
      [`${base}.breaking.0`, `${base}.breaking.1`],
      [`${base}.stale-ghost`]
    );
    expect(breakLock(lockPath(), undefined)).toBe('done'); // no lock at all: nothing to break
    expect(gens()).toEqual([1]);
  });
});

describe('who owns the newest turn', () => {
  const me = ident({ bootId: 'boot-b', pidNs: 'pid:[1]' });

  it('does not take a live breaker’s turn when its boot id is unknown', () => {
    const dead = stale();
    owner(1, { bootId: null, pidNs: 'pid:[1]', host: 'here' });
    expect(breakLock(lockPath(), dead, { identity: me, alive: () => true })).toBe('busy');
  });

  it('does not take a live breaker’s turn when our own boot id is unknown', () => {
    const dead = stale();
    owner(1, { bootId: 'boot-a', pidNs: 'pid:[1]', host: 'here' });
    expect(
      breakLock(lockPath(), dead, { identity: { ...me, bootId: null }, alive: () => true })
    ).toBe('busy');
  });

  it('does not take a live breaker’s turn when the boot ids are the same', () => {
    const dead = stale();
    owner(1, { bootId: 'boot-b', pidNs: 'pid:[1]', host: 'here' });
    expect(breakLock(lockPath(), dead, { identity: me, alive: () => true })).toBe('busy');
  });

  it('trusts the namespace over the host: another namespace on the same host is judged by age', () => {
    const dead = stale();
    owner(1, { bootId: null, pidNs: 'pid:[2]', host: 'here' });
    expect(breakLock(lockPath(), dead, { identity: me, alive: () => false })).toBe('busy');
  });

  it('trusts the namespace over the host: the same namespace on another host is judged by the pid', () => {
    const dead = stale();
    owner(1, { bootId: null, pidNs: 'pid:[1]', host: 'elsewhere' });
    expect(breakLock(lockPath(), dead, { identity: me, alive: () => false })).toBe('done');
  });

  it('falls back on the host when only the breaker’s namespace is unknown', () => {
    const dead = stale();
    owner(1, { bootId: null, pidNs: null, host: 'here' });
    expect(breakLock(lockPath(), dead, { identity: me, alive: () => false })).toBe('done');
  });

  it('falls back on the host when only our namespace is unknown', () => {
    const dead = stale();
    owner(1, { bootId: null, pidNs: 'pid:[1]', host: 'here' });
    expect(
      breakLock(lockPath(), dead, { identity: ident({ pidNs: null }), alive: () => false })
    ).toBe('done');
  });

  it('keeps a foreign turn exactly at the age bound, and takes it one millisecond later', () => {
    const dead = stale();
    owner(1, { bootId: null, pidNs: 'pid:[2]', host: 'there' });
    at(gen(1), 1_700_000_000_000);
    const mtime = statSync(gen(1)).mtimeMs;
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(mtime + BREAK_MUTEX_STALE_MS);
    expect(breakLock(lockPath(), dead, { identity: me })).toBe('busy');
    spy.mockReturnValue(mtime + BREAK_MUTEX_STALE_MS + 1);
    expect(breakLock(lockPath(), dead, { identity: me })).toBe('done');
  });
});

describe('the turn file', () => {
  it('records the identity it was given, or this process’s own', () => {
    const dead = stale();
    const given = ident({ host: 'custom-host', pidNs: 'pid:[7]', bootId: 'boot-x' });
    expect(breakLock(lockPath(), dead, { identity: given })).toBe('done');
    const first = JSON.parse(readFileSync(gen(1), 'utf8'));
    expect(first).toMatchObject({ host: 'custom-host', pidNs: 'pid:[7]', bootId: 'boot-x' });

    expect(breakLock(lockPath(), undefined)).toBe('done');
    const second = JSON.parse(readFileSync(gen(2), 'utf8'));
    expect(second.host).toBe(localIdentity().host);
    expect(second.pid).toBe(process.pid);
  });

  it('closes the descriptor of the turn when the break is over', () => {
    const dead = stale();
    expect(breakLock(lockPath(), dead)).toBe('done');
    expect(hooks.closeCalls).toBe(1);
  });

  it('closes the descriptor and removes the turn when it cannot be written', () => {
    const dead = stale();
    hooks.writeError = 'ENOSPC';
    expect(() => breakLock(lockPath(), dead)).toThrow(/ENOSPC/);
    expect(hooks.closeCalls).toBe(1);
    expect(gens()).toEqual([]);
  });

  it('closes the descriptor and removes the turn when a higher turn appeared meanwhile', () => {
    const dead = stale();
    const base = basename(lockPath());
    hooks.readdirViews.push([], [`${base}.breaking.1`, `${base}.breaking.2`]);
    expect(breakLock(lockPath(), dead)).toBe('busy');
    expect(hooks.closeCalls).toBe(1);
    expect(gens()).toEqual([]);
  });
});

describe('the wait loop', () => {
  it('flushes the lock file to disk and closes it once it holds it', async () => {
    await withLock(
      layout,
      async () => {
        expect(hooks.fsyncCalls).toBe(1);
        expect(hooks.closeCalls).toBe(1);
      },
      { create: true, heartbeatMs: 3_600_000 }
    );
  });

  it('tries again at once when an unreadable lock vanishes before its age is read', async () => {
    writeFileSync(lockPath(), '', { mode: 0o600 });
    at(lockPath(), Date.now() - 60_000);
    hooks.lockStatFailsOnce = true;
    const sleeps: number[] = [];
    const got = await withLock(layout, async () => 'ran', {
      create: true,
      waitMs: 60_000,
      sleep: async (ms) => void sleeps.push(ms)
    });
    expect(got).toBe('ran');
    expect(sleeps).toEqual([]);
  });

  it('keeps an unreadable lock exactly 5 s old as fresh', async () => {
    writeFileSync(lockPath(), '', { mode: 0o600 });
    at(lockPath(), 1_700_000_000_000);
    const mtime = statSync(lockPath()).mtimeMs;
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (++calls > 300) throw new Error('spun: the lock was judged stale');
      return mtime + 5_000;
    });
    await expect(
      withLock(layout, async () => 'ran', { create: true, waitMs: 0, now: () => 1000 })
    ).rejects.toThrow(LockError);
    expect(readdirSync(dir).filter((n) => n.includes('.breaking.'))).toEqual([]);
  });

  it('breaks a stale lock with the identity and liveness check it was given', async () => {
    // The lock and the breaker's turn both belong to "here" and are judged by the injected check.
    const me = ident();
    writeLock({ host: 'here', pidNs: null, bootId: null });
    owner(1, { pid: process.pid, host: 'here', pidNs: null, bootId: null });
    const got = await withLock(layout, async () => 'ran', {
      create: true,
      waitMs: 0,
      identity: me,
      alive: () => false
    });
    expect(got).toBe('ran');
  });

  it('gives up exactly when the deadline is reached while another breaker is at work', async () => {
    stale();
    writeFileSync(gen(1), '', { mode: 0o600 }); // fresh and unowned: busy
    let slept = 0;
    await expect(
      withLock(layout, async () => 'ran', {
        create: true,
        waitMs: 0,
        now: () => 1000,
        sleep: async () => {
          if (++slept > 3) throw new Error('slept past the deadline');
        }
      })
    ).rejects.toThrow(/clearing a stale lock/);
    expect(slept).toBe(0);
  });
});
