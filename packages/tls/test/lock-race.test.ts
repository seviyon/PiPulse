import { readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Layout } from '../src/layout.js';
import { LOCK_FILE, breakLock, localIdentity, withLock, type LockHolder } from '../src/lock.js';
import { tempDir } from './helpers.js';

// breakLock() puts a lock it moved aside back with linkSync(). The hook lets a test run code
// in the gap between its rename and that link, which is where a third process can slip in.
const gap = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: (existing: string, next: string) => {
      const run = gap.run;
      gap.run = undefined;
      run?.();
      return actual.linkSync(existing, next);
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
  gap.run = undefined;
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

describe('breakLock when a third process takes the path while a newer lock is moved aside', () => {
  // B judged holder A stale. Before B breaks it, A released and C took a new lock. B's rename
  // moves C's lock aside, finds the token differs, and wants to put it back; in that gap D
  // creates a lock of its own. link() then refuses to overwrite D's.
  it('leaves the newest lock in place and leaks no files', () => {
    const judged = JSON.parse(holder('stale-a')) as LockHolder;
    writeFileSync(lockPath(), holder('taken-by-c'), { mode: 0o600 });
    gap.run = () => writeFileSync(lockPath(), holder('taken-by-d'), { flag: 'wx', mode: 0o600 });

    expect(() => breakLock(lockPath(), judged)).not.toThrow();

    expect(tokenOnDisk()).toBe('taken-by-d');
    expect(readdirSync(dir).filter((name) => name.includes('.stale-'))).toEqual([]);
  });

  it('loses the displaced holder’s lock without telling anyone (current behaviour)', () => {
    // Pins what lock.ts's comment promises: C only finds out at release. Until then C and D both
    // run under "the" lock. If breakLock ever reports a displaced lock, change this test.
    const judged = JSON.parse(holder('stale-a')) as LockHolder;
    writeFileSync(lockPath(), holder('taken-by-c'), { mode: 0o600 });
    gap.run = () => writeFileSync(lockPath(), holder('taken-by-d'), { flag: 'wx', mode: 0o600 });

    const result = breakLock(lockPath(), judged) as unknown;

    expect(result).toBeUndefined();
    expect(tokenOnDisk()).not.toBe('taken-by-c');
  });

  it.todo('never lets two processes run at once after a break races a new acquirer');
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
