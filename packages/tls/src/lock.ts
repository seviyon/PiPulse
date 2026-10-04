import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs';
import { join } from 'node:path';
import type { Layout } from './layout.js';
import { pidAlive, processIdentity } from './proc.js';

export const LOCK_FILE = '.pipulse-tls.lock';
export const LOCK_WAIT_MS = 30_000;
/** Longer than any command holds it (enable waits for health twice, 30 s each). */
export const LOCK_STALE_MS = 15 * 60_000;
/** A lock file whose content isn't readable yet is being written, for this long. */
const FRESH_MS = 5_000;

export class LockError extends Error {
  override name = 'LockError';
}

export interface LockHolder {
  pid: number;
  startTime: string | null;
  startedAt: number;
}

function readHolder(path: string): LockHolder | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>;
    if (!Number.isInteger(value.pid) || typeof value.startedAt !== 'number') return undefined;
    return {
      pid: value.pid!,
      startTime: typeof value.startTime === 'string' ? value.startTime : null,
      startedAt: value.startedAt
    };
  } catch {
    return undefined;
  }
}

const holderAlive = (holder: LockHolder) => {
  const identity = processIdentity(holder.pid);
  if (identity && holder.startTime !== null) return identity.startTime === holder.startTime; // Linux: pid reuse is caught
  return pidAlive(holder.pid);
};

export interface LockOptions {
  /** Make caRoot when it is missing (commands that create a CA). Otherwise, no folder means nothing to guard yet. */
  create: boolean;
  waitMs?: number;
  staleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (holder: LockHolder) => boolean;
}

/**
 * Runs `fn` holding the one pipulse tls lock, so CA transactions, renewals and
 * mode switches from different processes (a manual new-ca, the hourly timer,
 * setup, the sidecar) never interleave. A lock whose holder is gone, or older
 * than staleMs, is cleared; a live holder is waited for up to waitMs, then
 * refused with a LockError. Released in `finally`, whatever `fn` does.
 */
export async function withLock<T>(
  layout: Layout,
  fn: () => Promise<T>,
  options: LockOptions
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = options.alive ?? holderAlive;
  if (!existsSync(layout.caRoot)) {
    if (!options.create) return fn();
    try {
      mkdirSync(layout.caRoot, { mode: 0o700 }); // ensureTlsDirs sets the final owner and mode
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const path = join(layout.caRoot, LOCK_FILE);
  const deadline = now() + (options.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (fd !== undefined) {
      try {
        writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            startTime: processIdentity(process.pid)?.startTime ?? null,
            startedAt: now()
          })
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    }
    const holder = readHolder(path);
    let stale: boolean;
    if (holder) {
      stale = !alive(holder) || now() - holder.startedAt > (options.staleMs ?? LOCK_STALE_MS);
    } else {
      let age: number;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // released meanwhile: try again at once
      }
      stale = age > FRESH_MS;
    }
    if (stale) {
      rmSync(path, { force: true });
      continue;
    }
    if (now() >= deadline) {
      throw new LockError(
        `another pipulse tls command is running (pid ${holder?.pid ?? '?'}); try again when it has finished`
      );
    }
    await sleep(500);
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
