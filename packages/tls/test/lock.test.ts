import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Layout } from '../src/layout.js';
import {
  LOCK_FILE,
  LOCK_OBSERVE_MS,
  LockError,
  breakLock,
  localIdentity,
  withLock,
  type LockHolder
} from '../src/lock.js';
import { tempDir } from './helpers.js';

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
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const lockPath = () => join(dir, LOCK_FILE);
/** A lock file as a holder on this very process's side of the PID namespace would write it. */
const writeHolder = (over: Partial<LockHolder> = {}) =>
  writeFileSync(
    lockPath(),
    JSON.stringify({
      pid: 999_999,
      ...localIdentity(),
      startTime: null,
      token: 'other',
      startedAt: Date.now(),
      ...over
    }),
    { mode: 0o600 }
  );
const other = { pidNs: 'pid:[4026539999]', host: 'container-b' } as const;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('withLock', () => {
  it('holds pid, start time and time in a 0600 file while the command runs, and removes it after', async () => {
    const seen = await withLock(
      layout,
      async () => ({
        holder: JSON.parse(readFileSync(lockPath(), 'utf8')),
        mode: statSync(lockPath()).mode & 0o777
      }),
      { create: true }
    );
    expect(seen.holder.pid).toBe(process.pid);
    expect(seen.holder).toHaveProperty('startTime');
    expect(seen.holder.token).toMatch(/^[0-9a-f]{32}$/);
    expect(seen.holder).toHaveProperty('bootId');
    expect(seen.holder).toHaveProperty('pidNs');
    expect(seen.holder.host).toBe(localIdentity().host);
    expect(seen.mode).toBe(0o600);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('serializes two overlapping commands: the second waits, nothing interleaves', async () => {
    const events: string[] = [];
    const first = withLock(
      layout,
      async () => {
        events.push('a start');
        await pause(100);
        events.push('a end');
      },
      { create: true }
    );
    await pause(10);
    const second = withLock(
      layout,
      async () => {
        events.push('b start');
        events.push('b end');
      },
      { create: true, waitMs: 5000, sleep: () => pause(20) }
    );
    await Promise.all([first, second]);
    expect(events).toEqual(['a start', 'a end', 'b start', 'b end']);
  });

  it('refuses when the holder is still running after the wait', async () => {
    let release!: () => void;
    const held = withLock(layout, () => new Promise<void>((resolve) => (release = resolve)), {
      create: true
    });
    await pause(10);
    await expect(withLock(layout, async () => 'no', { create: true, waitMs: 0 })).rejects.toThrow(
      /another pipulse tls command is running \(pid \d+\)/
    );
    release();
    await held;
  });

  it('clears the lock of a process that died holding it (a crash)', async () => {
    writeHolder();
    expect(
      await withLock(layout, async () => 'ran', { create: true, waitMs: 0, alive: () => false })
    ).toBe('ran');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('clears a lock older than the bound even if its pid runs (pid reuse)', async () => {
    writeHolder({ pid: process.pid, startedAt: Date.now() - 16 * 60_000 });
    expect(await withLock(layout, async () => 'ran', { create: true, waitMs: 0 })).toBe('ran');
  });

  it('treats an empty lock as being written for 5 s, then as stale', async () => {
    writeFileSync(lockPath(), '');
    await expect(withLock(layout, async () => 'no', { create: true, waitMs: 0 })).rejects.toThrow(
      LockError
    );
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockPath(), old, old);
    expect(await withLock(layout, async () => 'ran', { create: true, waitMs: 0 })).toBe('ran');
  });

  it('does not judge a holder in another container by its pid: a fresh heartbeat keeps the lock', async () => {
    // pid 1 exists here too, but it is not the other container's pid 1.
    writeHolder({ ...other, pid: process.pid });
    await expect(
      withLock(layout, async () => 'no', { create: true, waitMs: 0, alive: () => false })
    ).rejects.toThrow(/on container-b/);
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('other');
  });

  /** A monotonic clock the fake sleep advances, so a 45 s observation takes no real time. */
  const fakeTime = (onSleep?: () => void) => {
    let t = 0;
    return {
      monotonic: () => t,
      sleep: async (ms: number) => {
        t += ms;
        onSleep?.();
      }
    };
  };

  it('clears a lock from another container whose heartbeat stays unchanged while watched', async () => {
    writeHolder({ ...other });
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockPath(), old, old);
    const time = fakeTime();
    expect(await withLock(layout, async () => 'ran', { create: true, waitMs: 0, ...time })).toBe(
      'ran'
    );
    expect(time.monotonic()).toBeGreaterThanOrEqual(LOCK_OBSERVE_MS);
  });

  it('keeps a remote holder whose heartbeat shows up while watched (a forward clock jump)', async () => {
    writeHolder({ ...other });
    const old = new Date(Date.now() - 2 * 3_600_000); // looks 2 h old after a jump
    utimesSync(lockPath(), old, old);
    const time = fakeTime(() => {
      const now = new Date();
      utimesSync(lockPath(), now, now); // the holder's next heartbeat
    });
    await expect(
      withLock(layout, async () => 'no', { create: true, waitMs: 0, ...time })
    ).rejects.toThrow(/on container-b/);
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('other');
  });

  it('never breaks a verified live holder because of its age (a wall-clock jump)', async () => {
    let wall = Date.now();
    let release!: () => void;
    const held = withLock(layout, () => new Promise<void>((resolve) => (release = resolve)), {
      create: true,
      now: () => wall,
      alive: () => true // /proc doesn't exist on every dev machine; Linux verifies for real
    });
    await pause(10);
    wall += 2 * 3_600_000; // NTP syncs: two hours forward
    await expect(
      withLock(layout, async () => 'no', {
        create: true,
        waitMs: 0,
        now: () => wall,
        alive: () => true
      })
    ).rejects.toThrow(LockError);
    release();
    await held;
  });

  it('still bounds the age of a holder whose identity cannot be verified', async () => {
    writeHolder({ pid: process.pid, startedAt: Date.now() - 16 * 60_000, startTime: null });
    expect(await withLock(layout, async () => 'ran', { create: true, waitMs: 0 })).toBe('ran');
  });

  it('keeps the lock fresh with a heartbeat while the command runs', async () => {
    let first = 0;
    let second = 0;
    await withLock(
      layout,
      async () => {
        const old = new Date(Date.now() - 60_000);
        utimesSync(lockPath(), old, old);
        first = statSync(lockPath()).mtimeMs;
        await pause(120);
        second = statSync(lockPath()).mtimeMs;
      },
      { create: true, heartbeatMs: 20 }
    );
    expect(second).toBeGreaterThan(first + 30_000);
  });

  it('clears a lock from before a reboot, whatever its pid and namespace say', async () => {
    writeHolder({ pid: process.pid, bootId: 'an-older-boot' });
    const me = localIdentity();
    if (me.bootId === null) return; // no /proc boot id here: nothing to compare
    expect(
      await withLock(layout, async () => 'ran', { create: true, waitMs: 0, identity: me })
    ).toBe('ran');
  });

  it('does not remove a lock somebody else holds when the command ends', async () => {
    await withLock(
      layout,
      async () => {
        writeHolder({ token: 'taken-over' }); // broken and retaken meanwhile
      },
      { create: true }
    );
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('taken-over');
  });

  it('breaks a stale lock only if it is still the one judged stale', () => {
    writeHolder({ token: 'dead' });
    const dead = JSON.parse(readFileSync(lockPath(), 'utf8')) as LockHolder;
    breakLock(lockPath(), dead);
    expect(existsSync(lockPath())).toBe(false);

    // Meanwhile a fresh holder took the lock: the break must put it back.
    writeHolder({ token: 'fresh' });
    breakLock(lockPath(), dead);
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('fresh');
    expect(readdirSync(dir).filter((n) => n.includes('.stale-'))).toEqual([]);
  });

  it('does not delete a new, still-empty lock when the judged-stale one was unreadable', () => {
    // Waiter B judged an empty lock stale; before it breaks it, waiter A broke that one and made
    // its own (created, not yet written). B's rename picks up A's file: unreadable, token null.
    writeFileSync(lockPath(), '');
    breakLock(lockPath(), undefined);
    expect(existsSync(lockPath())).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes('.stale-'))).toEqual([]);
  });

  it('still removes an old unreadable lock judged stale', () => {
    writeFileSync(lockPath(), '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(), old, old);
    breakLock(lockPath(), undefined);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('releases the lock when the command throws', async () => {
    await expect(
      withLock(
        layout,
        async () => {
          throw new Error('boom');
        },
        { create: true }
      )
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('without a CA folder: makes it for commands that create a CA, runs the rest unlocked', async () => {
    const tls = join(dir, 'tls');
    const missing = { ...layout, tlsDir: tls, caRoot: tls };
    expect(
      await withLock(missing, async () => existsSync(join(tls, LOCK_FILE)), { create: false })
    ).toBe(false);
    expect(existsSync(tls)).toBe(false);
    expect(
      await withLock(missing, async () => existsSync(join(tls, LOCK_FILE)), { create: true })
    ).toBe(true);
  });
});
