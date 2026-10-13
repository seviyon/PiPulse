import {
  chmodSync,
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
  LOCK_HEARTBEAT_MS,
  LOCK_WAIT_MS,
  LOCK_OBSERVE_MS,
  LockError,
  breakLock,
  localIdentity,
  withLock,
  type LockHolder
} from '../src/lock.js';
import { processIdentity } from '../src/proc.js';
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

  describe('the wait is bounded on the monotonic clock', () => {
    const hold = () => {
      let release!: () => void;
      const held = withLock(layout, () => new Promise<void>((resolve) => (release = resolve)), {
        create: true,
        alive: () => true
      });
      return { held, release: () => release() };
    };

    it('a wall clock that jumps a day ahead does not end the wait early', async () => {
      const holder = hold();
      await pause(10);
      let wall = Date.now();
      let mono = 0;
      let sleeps = 0;
      const waiter = withLock(layout, async () => 'ran', {
        create: true,
        waitMs: 5000,
        alive: () => true,
        now: () => wall,
        monotonic: () => mono,
        sleep: async () => {
          sleeps++;
          wall += 86_400_000; // NTP steps the clock a day forward on every sleep
          mono += 100;
          if (sleeps === 3) holder.release();
          await pause(20);
        }
      });
      expect(await waiter).toBe('ran');
      expect(sleeps).toBeGreaterThanOrEqual(3);
      await holder.held;
    });

    it('without waitMs it gives up after the default wait', async () => {
      const holder = hold();
      await pause(10);
      let mono = 0;
      await expect(
        withLock(layout, async () => 'no', {
          create: true,
          alive: () => true,
          monotonic: () => mono,
          sleep: async () => {
            mono += LOCK_WAIT_MS / 2;
          }
        })
      ).rejects.toThrow(LockError);
      expect(mono).toBeGreaterThanOrEqual(LOCK_WAIT_MS);
      holder.release();
      await holder.held;
    });

    it('a wall clock stuck in place does not stretch it', async () => {
      const holder = hold();
      await pause(10);
      const wall = Date.now();
      let mono = 0;
      await expect(
        withLock(layout, async () => 'no', {
          create: true,
          waitMs: 1000,
          alive: () => true,
          now: () => wall,
          monotonic: () => mono,
          sleep: async () => {
            mono += 400;
          }
        })
      ).rejects.toThrow(LockError);
      holder.release();
      await holder.held;
    });
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
      { create: true, onLost: () => undefined }
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

  describe('breakers take turns (numbered mutex files beside the lock)', () => {
    // Generation n is `<lock>.breaking.<n>`. A breaker takes a turn by creating the next number
    // with O_EXCL (one creator wins), and gives it back by writing "released" into its own file.
    // Nothing is ever deleted to make room, so there is no leftover to clear and no window in
    // which a live breaker's file could be removed by mistake.
    const gen = (n: number) => `${lockPath()}.breaking.${n}`;
    const gens = () =>
      readdirSync(dir)
        .filter((name) => /\.breaking\.\d+$/.test(name))
        .map((name) => Number(name.slice(name.lastIndexOf('.') + 1)))
        .sort((a, b) => a - b);
    const released = (n: number) => JSON.parse(readFileSync(gen(n), 'utf8')).released === true;
    const stale = () => {
      writeHolder({ token: 'dead' });
      return JSON.parse(readFileSync(lockPath(), 'utf8')) as LockHolder;
    };
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
    const age = (n: number, ms: number) => {
      const at = new Date(Date.now() + ms);
      utimesSync(gen(n), at, at);
    };

    it('leaves the lock alone while another breaker holds a turn', () => {
      const dead = stale();
      owner(1, { pid: process.pid }); // alive: this very process
      expect(breakLock(lockPath(), dead)).toBe('busy');
      expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('dead');
      expect(gens()).toEqual([1]); // and its file is not touched
    });

    it('breaks the lock, then marks its turn released rather than deleting it', () => {
      const dead = stale();
      expect(breakLock(lockPath(), dead)).toBe('done');
      expect(existsSync(lockPath())).toBe(false);
      expect(gens()).toEqual([1]);
      expect(released(1)).toBe(true);
    });

    it('takes the next number after a released turn, and tidies the older ones', () => {
      const dead = stale();
      writeFileSync(gen(1), JSON.stringify({ released: true }));
      writeFileSync(gen(2), JSON.stringify({ released: true }));
      expect(breakLock(lockPath(), dead)).toBe('done');
      expect(gens()).toEqual([3]);
      expect(released(3)).toBe(true);
    });

    it('leaves a lock that turns out to be another holder’s where it is', () => {
      const dead = stale();
      writeHolder({ token: 'fresh' });
      expect(breakLock(lockPath(), dead)).toBe('done');
      expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('fresh');
      expect(released(1)).toBe(true);
    });

    it('takes over the turn of a breaker that died, at once and without deleting anything first', () => {
      const dead = stale();
      owner(4); // pid 999999: not running
      expect(breakLock(lockPath(), dead)).toBe('done');
      expect(existsSync(lockPath())).toBe(false);
      expect(gens()).toEqual([5]);
    });

    it('takes over a turn whose file was never written (a breaker killed at that instant), once it is old', () => {
      const dead = stale();
      writeFileSync(gen(1), '', { mode: 0o600 });
      expect(breakLock(lockPath(), dead)).toBe('busy'); // fresh: the creator may still be writing
      age(1, -60_000);
      expect(breakLock(lockPath(), dead)).toBe('done');
      expect(gens()).toEqual([2]);
    });

    it('never takes the turn of a breaker that is alive, however old its file: a stalled breaker keeps it', () => {
      const dead = stale();
      owner(1, { pid: process.pid });
      age(1, -3_600_000);
      expect(breakLock(lockPath(), dead)).toBe('busy');
      expect(gens()).toEqual([1]);
    });

    it('treats a turn file dated far in the future as old (the clock was stepped back)', () => {
      const dead = stale();
      writeFileSync(gen(1), '', { mode: 0o600 });
      age(1, 3_600_000);
      expect(breakLock(lockPath(), dead)).toBe('done');
    });

    describe('who owns the newest turn', () => {
      const me = { startTime: null, bootId: 'boot-b', pidNs: 'pid:[1]', host: 'here' };

      it('takes the turn of a breaker from before a reboot, whatever its pid', () => {
        const dead = stale();
        owner(1, { pid: process.pid, bootId: 'boot-a', pidNs: 'pid:[1]', host: 'here' });
        expect(breakLock(lockPath(), dead, { identity: me })).toBe('done');
      });

      it('judges a breaker in another PID namespace by the age of its file, not by a pid it cannot see', () => {
        const dead = stale();
        owner(1, { pid: process.pid, bootId: 'boot-b', pidNs: 'pid:[2]', host: 'there' });
        expect(breakLock(lockPath(), dead, { identity: me })).toBe('busy'); // fresh: still at work
        age(1, -60_000);
        expect(breakLock(lockPath(), dead, { identity: me })).toBe('done'); // silent for a minute: gone
      });

      it('judges a breaker in our own namespace by the liveness check it is given', () => {
        const dead = stale();
        owner(1, { bootId: 'boot-b', pidNs: 'pid:[1]', host: 'here' });
        expect(breakLock(lockPath(), dead, { identity: me, alive: () => true })).toBe('busy');
        expect(breakLock(lockPath(), dead, { identity: me, alive: () => false })).toBe('done');
      });

      it('falls back on the host name when a namespace is not known', () => {
        const dead = stale();
        owner(1, { pid: process.pid, bootId: null, pidNs: null, host: 'elsewhere' });
        const noNs = { ...me, bootId: null, pidNs: null };
        expect(breakLock(lockPath(), dead, { identity: noNs })).toBe('busy'); // another host: by age
        age(1, -60_000);
        expect(breakLock(lockPath(), dead, { identity: noNs })).toBe('done');
      });
    });

    it.skipIf(process.getuid?.() === 0)('does not hide a failure to make its turn file', () => {
      const dead = stale();
      chmodSync(dir, 0o500);
      try {
        expect(() => breakLock(lockPath(), dead)).toThrow(/EACCES/);
      } finally {
        chmodSync(dir, 0o700);
      }
    });

    it('answers busy while the newest turn belongs to a live breaker, whatever older ones it finds', () => {
      const dead = stale();
      owner(1); // dead owner
      // The first breaker has taken number 2 by the time the second tries to: it is alive.
      owner(2, { pid: process.pid });
      expect(breakLock(lockPath(), dead)).toBe('busy');
      expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('dead');
    });

    it('stops waiting at waitMs while another breaker holds the turn, with a message that says why', async () => {
      stale();
      writeFileSync(gen(1), '', { mode: 0o600 }); // fresh and unowned: busy for 10 s
      const started = Date.now();
      await expect(
        withLock(layout, async () => 'ran', { create: true, waitMs: 150 })
      ).rejects.toThrow(/clearing a stale lock/);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('a waiter holds off while a break is under way, then takes the lock once it is over', async () => {
      stale();
      owner(1, { pid: process.pid });
      setTimeout(() => {
        rmSync(lockPath(), { force: true }); // the other breaker finishes: the lock goes, its turn is released
        writeFileSync(gen(1), JSON.stringify({ released: true }));
      }, 60);
      const started = Date.now();
      const got = await withLock(layout, async () => 'ran', { create: true, waitMs: 5000 });
      expect(got).toBe('ran');
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    });
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

describe('lock constants and errors', () => {
  it('watches a remote heartbeat for two beats and 5 s (45 s)', () => {
    expect(LOCK_HEARTBEAT_MS).toBe(20_000);
    expect(LOCK_OBSERVE_MS).toBe(45_000);
  });

  it('refuses with a LockError that says so', async () => {
    writeHolder({ pid: process.pid });
    const error = await withLock(layout, async () => 'no', { create: true, waitMs: 0 }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(LockError);
    expect((error as Error).name).toBe('LockError');
  });
});

describe('a lock file that is not a lock holder', () => {
  // A fresh file with unusable content is somebody's lock being written: it is waited for,
  // and the message cannot name a pid.
  it.each([
    ['a pid that is not an integer', { pid: 1.5, startedAt: Date.now() }],
    ['a start time that is not a number', { pid: 4242, startedAt: 'now' }],
    ['no pid', { startedAt: Date.now() }]
  ])('treats %s as unreadable', async (_name, content) => {
    writeFileSync(lockPath(), JSON.stringify(content));
    await expect(withLock(layout, async () => 'no', { create: true, waitMs: 0 })).rejects.toThrow(
      /\(pid \?\)/
    );
  });

  it('names the pid of a real holder', async () => {
    writeHolder({ pid: process.pid });
    await expect(withLock(layout, async () => 'no', { create: true, waitMs: 0 })).rejects.toThrow(
      new RegExp(`pid ${process.pid}`)
    );
  });
});

// /proc has the process start time only on Linux (the CI and the packaging container run it).
describe.skipIf(!existsSync('/proc/self/stat'))('a pid that was reused (Linux)', () => {
  it('is not the holder when the start time differs, and is when it matches', async () => {
    const mine = processIdentity(process.pid)!;
    writeHolder({ pid: process.pid, startTime: 'not-my-start' });
    expect(await withLock(layout, async () => 'ran', { create: true, waitMs: 0 })).toBe('ran');
    writeHolder({ pid: process.pid, startTime: mine.startTime });
    await expect(withLock(layout, async () => 'no', { create: true, waitMs: 0 })).rejects.toThrow(
      LockError
    );
  });
});
