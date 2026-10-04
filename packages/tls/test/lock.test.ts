import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Layout } from '../src/layout.js';
import { LOCK_FILE, LockError, withLock } from '../src/lock.js';
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
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 999_999, startTime: null, startedAt: Date.now() }),
      { mode: 0o600 }
    );
    expect(
      await withLock(layout, async () => 'ran', { create: true, waitMs: 0, alive: () => false })
    ).toBe('ran');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('clears a lock older than the bound even if its pid runs (pid reuse)', async () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid, startTime: null, startedAt: Date.now() - 16 * 60_000 })
    );
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
