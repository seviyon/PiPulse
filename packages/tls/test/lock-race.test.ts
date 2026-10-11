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
  renameError: undefined as string | undefined,
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
      if (gap.renameError) {
        throw Object.assign(new Error(gap.renameError), { code: gap.renameError });
      }
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
  gap.renameError = undefined;
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
    // The one race left, and only when the judged holder was still alive: A released, C took the
    // path, and D took it again during the put-back. C only finds out at release. (Waiters that
    // all judged a *dead* holder no longer reach this: breakers take turns, see lock.test.ts and
    // lock-stress.test.ts.) If breakLock ever reports a displaced lock, change this test.
    writeFileSync(lockPath(), holder('stale-a'), { mode: 0o600 });
    gap.rename = takeAs('taken-by-c');
    gap.links.push(
      () => undefined,
      () => writeFileSync(lockPath(), holder('taken-by-d'), { flag: 'wx', mode: 0o600 })
    );

    const result = breakLock(lockPath(), judgedA());

    expect(result).toBe('done'); // it reports no displaced lock
    expect(tokenOnDisk()).not.toBe('taken-by-c');
  });

  it('tells the displaced holder when its command ends', async () => {
    const lost = vi.fn();
    await withLock(layout, async () => takeAs('taken-by-d')(), { create: true, onLost: lost });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(tokenOnDisk()).toBe('taken-by-d');
  });

  it('tells a holder whose lock file vanished, and stays quiet when nothing went wrong', async () => {
    const lost = vi.fn();
    await withLock(layout, async () => rmSync(lockPath()), { create: true, onLost: lost });
    expect(lost).toHaveBeenCalledTimes(1);
    await withLock(layout, async () => undefined, { create: true, onLost: lost });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('warns on stderr by default', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await withLock(layout, async () => takeAs('taken-by-d')(), { create: true });
      expect(write).toHaveBeenCalledWith(expect.stringContaining('lock was taken over'));
    } finally {
      write.mockRestore();
    }
  });
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
      { create: true, heartbeatMs: 30, onLost: () => undefined }
    );
    expect(result).toBe(0);
  });
});

// Found by mutation testing: none of the error branches of breakLock were tested.
describe('breakLock, when the file system misbehaves', () => {
  const stale = () => writeFileSync(lockPath(), holder('stale-a'), { mode: 0o600 });

  it('does nothing when there is no lock any more', () => {
    expect(() => breakLock(lockPath(), judgedA())).not.toThrow();
    expect(staleCopies()).toEqual([]);
    gap.linkError = 'EPERM'; // the fallback finds nothing either
    expect(() => breakLock(lockPath(), judgedA())).not.toThrow();
  });

  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'])(
    'falls back to rename-first when hard links fail with %s',
    (code) => {
      stale();
      gap.linkError = code;
      breakLock(lockPath(), judgedA());
      expect(existsSync(lockPath())).toBe(false);
      expect(staleCopies()).toEqual([]);
    }
  );

  it('does not hide any other error from link()', () => {
    stale();
    gap.linkError = 'EACCES';
    expect(() => breakLock(lockPath(), judgedA())).toThrow('EACCES');
    expect(readFileSync(lockPath(), 'utf8')).toContain('stale-a');
  });

  it('gives up quietly when the lock goes away between the check and the rename', () => {
    stale();
    gap.rename = () => rmSync(lockPath());
    expect(() => breakLock(lockPath(), judgedA())).not.toThrow();
    expect(staleCopies()).toEqual([]);
  });

  it('does not hide a rename error, and leaves no copy behind', () => {
    stale();
    gap.renameError = 'EACCES';
    expect(() => breakLock(lockPath(), judgedA())).toThrow('EACCES');
    expect(staleCopies()).toEqual([]);
  });

  it('does not hide a rename error in the fallback either', () => {
    stale();
    gap.linkError = 'EPERM';
    gap.renameError = 'EIO';
    expect(() => breakLock(lockPath(), judgedA())).toThrow('EIO');
  });

  it('the fallback gives up quietly when the lock vanished before its rename', () => {
    stale();
    gap.linkError = 'EPERM';
    gap.renameError = 'ENOENT';
    expect(() => breakLock(lockPath(), judgedA())).not.toThrow();
  });
});
