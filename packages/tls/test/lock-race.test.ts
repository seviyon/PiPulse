import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Layout } from '../src/layout.js';
import { LOCK_FILE, breakLock, localIdentity, withLock, type LockHolder } from '../src/lock.js';
import { tempDir } from './helpers.js';

// breakLock() links the lock to a second name, renames it away, and may put it back with
// linkSync(). The hooks let a test run code just before the n-th link or the first rename,
// which is where other processes can slip in.
const gap = vi.hoisted(() => ({
  links: [] as (() => void)[],
  rename: undefined as (() => void) | undefined,
  linkError: undefined as string | undefined,
  linkCalls: 0,
  renameCalls: 0
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: (existing: string, next: string) => {
      gap.linkCalls += 1;
      if (gap.linkError && gap.linkCalls === 1) {
        throw Object.assign(new Error(gap.linkError), { code: gap.linkError });
      }
      gap.links.shift()?.();
      return actual.linkSync(existing, next);
    },
    renameSync: (from: string, to: string) => {
      gap.renameCalls += 1;
      const run = gap.rename;
      gap.rename = undefined;
      run?.();
      return actual.renameSync(from, to);
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
  gap.links = [];
  gap.rename = undefined;
  gap.linkError = undefined;
  gap.linkCalls = 0;
  gap.renameCalls = 0;
  rmSync(dir, { recursive: true, force: true });
});
const lockPath = () => join(dir, LOCK_FILE);
const holder = (token: string): string =>
  JSON.stringify({
    pid: 999_999,
    ...localIdentity(),
    startTime: null,
    token,
    startedAt: Date.now()
  });
const tokenOnDisk = () => (JSON.parse(readFileSync(lockPath(), 'utf8')) as LockHolder).token;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const staleCopies = () => readdirSync(dir).filter((name) => name.includes('.stale-'));
const judgedA = () => JSON.parse(holder('stale-a')) as LockHolder;
const takeAs = (token: string) => () => {
  rmSync(lockPath(), { force: true });
  writeFileSync(lockPath(), holder(token), { flag: 'wx', mode: 0o600 });
};

describe('breakLock when the lock is no longer the one judged stale', () => {
  // B judged holder A stale. Before B acts, A released and C took a new lock.
  it('never moves the path while it checks a lock that is not the judged one', () => {
    writeFileSync(lockPath(), holder('taken-by-c'), { mode: 0o600 });
    const present: boolean[] = [];
    gap.links.push(() => present.push(existsSync(lockPath())));

    expect(() => breakLock(lockPath(), judgedA())).not.toThrow();

    expect(gap.renameCalls).toBe(0);
    expect(present).toEqual([true]);
    expect(tokenOnDisk()).toBe('taken-by-c');
    expect(staleCopies()).toEqual([]);
  });

  // A is judged, then released and C takes the path in the instant before B's rename.
  it('puts the newer lock back when it is swapped in just before the rename', () => {
    writeFileSync(lockPath(), holder('stale-a'), { mode: 0o600 });
    gap.rename = takeAs('taken-by-c');

    breakLock(lockPath(), judgedA());

    expect(tokenOnDisk()).toBe('taken-by-c');
    expect(staleCopies()).toEqual([]);
  });

  it('removes the judged lock, and leaks nothing', () => {
    writeFileSync(lockPath(), holder('stale-a'), { mode: 0o600 });
    breakLock(lockPath(), judgedA());
    expect(existsSync(lockPath())).toBe(false);
    expect(staleCopies()).toEqual([]);
  });

  it('falls back to rename-first on a filesystem that cannot hard-link', () => {
    gap.linkError = 'EPERM'; // the first link() of each run fails
    writeFileSync(lockPath(), holder('taken-by-c'), { mode: 0o600 });
    breakLock(lockPath(), judgedA());
    expect(tokenOnDisk()).toBe('taken-by-c'); // moved aside, found newer, put back
    expect(staleCopies()).toEqual([]);

    writeFileSync(lockPath(), holder('stale-a'), { mode: 0o600 });
    gap.linkCalls = 0;
    breakLock(lockPath(), judgedA());
    expect(existsSync(lockPath())).toBe(false); // the judged lock is removed
    expect(staleCopies()).toEqual([]);
  });

  it('keeps the lock that was put back when a third process takes the path meanwhile', () => {
    writeFileSync(lockPath(), holder('stale-a'), { mode: 0o600 });
    gap.rename = takeAs('taken-by-c');
    // link #1 is the check; link #2 is the put-back, where D slips in.
    gap.links.push(
      () => undefined,
      () => writeFileSync(lockPath(), holder('taken-by-d'), { flag: 'wx', mode: 0o600 })
    );

    expect(() => breakLock(lockPath(), judgedA())).not.toThrow();

    expect(tokenOnDisk()).toBe('taken-by-d');
    expect(staleCopies()).toEqual([]);
  });

  it('loses the displaced holder’s lock without telling anyone (current behaviour)', () => {
    // The one race left: A released, C took the path, and D took it again during the put-back.
    // C only finds out at release. If breakLock ever reports a displaced lock, change this test.
    writeFileSync(lockPath(), holder('stale-a'), { mode: 0o600 });
    gap.rename = takeAs('taken-by-c');
    gap.links.push(
      () => undefined,
      () => writeFileSync(lockPath(), holder('taken-by-d'), { flag: 'wx', mode: 0o600 })
    );

    const result = breakLock(lockPath(), judgedA()) as unknown;

    expect(result).toBeUndefined();
    expect(tokenOnDisk()).not.toBe('taken-by-c');
  });

  it.todo('reports a displaced holder instead of leaving it to find out at release');
});

describe('the heartbeat', () => {
  // Desired: a holder whose lock was broken and retaken must not keep refreshing the new
  // holder's file, or a dead new holder in another container looks alive past its 90 s bound.
  it('does not touch a lock that now carries another holder’s token', async () => {
    const result = await withLock(
      layout,
      async () => {
        writeFileSync(lockPath(), holder('taken-over'), { mode: 0o600 });
        const old = new Date(Date.now() - 3_600_000);
        utimesSync(lockPath(), old, old);
        const before = statSync(lockPath()).mtimeMs;
        await pause(150);
        return statSync(lockPath()).mtimeMs - before;
      },
      { create: true, heartbeatMs: 30 }
    );
    expect(result).toBe(0);
  });
});
