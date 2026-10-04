import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathExists } from './files.js';
import type { Layout } from './layout.js';
import { pidAlive, pidNamespace, processIdentity } from './proc.js';

export const LOCK_FILE = '.pipulse-tls.lock';
export const LOCK_WAIT_MS = 30_000;
/** Longer than any command holds it (enable waits for health twice, 30 s each). */
export const LOCK_STALE_MS = 15 * 60_000;
/** A lock file whose content isn't readable yet is being written, for this long. */
const FRESH_MS = 5_000;
/** The holder touches the lock this often; a holder we can't see in /proc is judged by it. */
export const LOCK_HEARTBEAT_MS = 20_000;
/** A holder in another PID namespace (another container) is gone after this long without a heartbeat. */
export const LOCK_REMOTE_STALE_MS = 90_000;

export class LockError extends Error {
  override name = 'LockError';
}

export interface LockHolder {
  pid: number;
  startTime: string | null;
  bootId: string | null;
  /** The holder's PID namespace; a pid is only checkable by a process in the same one. */
  pidNs: string | null;
  host: string;
  /** Random per acquisition: releasing and breaking compare it, so nobody removes a lock that isn't theirs. */
  token: string | null;
  startedAt: number;
}

/** What this process is, as a lock holder would record it. */
export interface LocalIdentity {
  startTime: string | null;
  bootId: string | null;
  pidNs: string | null;
  host: string;
}

export function localIdentity(): LocalIdentity {
  const identity = processIdentity(process.pid);
  return {
    startTime: identity?.startTime ?? null,
    bootId: identity?.bootId ?? null,
    pidNs: pidNamespace() ?? null,
    host: hostname()
  };
}

function readHolder(path: string): LockHolder | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>;
    if (!Number.isInteger(value.pid) || typeof value.startedAt !== 'number') return undefined;
    const text = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      pid: value.pid!,
      startTime: text(value.startTime),
      bootId: text(value.bootId),
      pidNs: text(value.pidNs),
      host: text(value.host) ?? '',
      token: text(value.token),
      startedAt: value.startedAt
    };
  } catch {
    return undefined;
  }
}

/** The holder's pid, checked against /proc, for a holder in our own PID namespace. */
const localHolderAlive = (holder: LockHolder) => {
  const identity = processIdentity(holder.pid);
  if (identity && holder.startTime !== null) return identity.startTime === holder.startTime; // pid reuse is caught
  return pidAlive(holder.pid);
};

export interface LockOptions {
  /** Make caRoot when it is missing (commands that create a CA). Otherwise, no folder means nothing to guard yet. */
  create: boolean;
  waitMs?: number;
  staleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the check that a holder in our own PID namespace is still running. */
  alive?: (holder: LockHolder) => boolean;
  /** Overrides this process's identity (tests simulate another container). */
  identity?: LocalIdentity;
  heartbeatMs?: number;
  remoteStaleMs?: number;
}

/**
 * Clears a lock judged stale without trusting that judgement blindly: it is
 * renamed to a unique name first and re-read there. If it turns out to be a
 * different holder's (somebody broke it and took a fresh one meanwhile), it is
 * put back with link(), which fails rather than overwrite a newer lock.
 */
export function breakLock(path: string, judged: LockHolder | undefined): void {
  const aside = `${path}.stale-${randomBytes(6).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const taken = readHolder(aside);
    if ((taken?.token ?? null) !== (judged?.token ?? null)) {
      try {
        linkSync(aside, path);
      } catch {
        // Somebody already took a newer lock; the one we moved is gone. Its holder will see
        // at release that the file isn't theirs.
      }
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Runs `fn` holding the one pipulse tls lock, so CA transactions, renewals and
 * mode switches from different processes (a manual new-ca, the hourly timer,
 * setup, the sidecar) never interleave. A holder in our PID namespace is
 * judged by its pid and start time; one in another namespace (another
 * container on a shared volume) or on another boot by its heartbeat, the lock
 * file's mtime. A lock whose holder is gone, or older than staleMs, is cleared;
 * a live holder is waited for up to waitMs, then refused with a LockError.
 * Released in `finally` only if the file still carries our token.
 */
export async function withLock<T>(
  layout: Layout,
  fn: () => Promise<T>,
  options: LockOptions
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const me = options.identity ?? localIdentity();
  if (!pathExists(layout.caRoot)) {
    if (!options.create) return fn();
    try {
      mkdirSync(layout.caRoot, { mode: 0o700 }); // ensureTlsDirs sets the final owner and mode
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const path = join(layout.caRoot, LOCK_FILE);
  const token = randomBytes(16).toString('hex');
  const deadline = now() + (options.waitMs ?? LOCK_WAIT_MS);

  const heartbeatAge = () => {
    try {
      return Date.now() - statSync(path).mtimeMs;
    } catch {
      return undefined; // released meanwhile
    }
  };
  const holderGone = (holder: LockHolder): boolean => {
    if (holder.bootId !== null && me.bootId !== null && holder.bootId !== me.bootId) return true; // before a reboot
    const sameNamespace =
      holder.pidNs !== null && me.pidNs !== null
        ? holder.pidNs === me.pidNs
        : holder.host === me.host;
    if (sameNamespace) return !(options.alive ?? localHolderAlive)(holder);
    const age = heartbeatAge();
    return age !== undefined && age > (options.remoteStaleMs ?? LOCK_REMOTE_STALE_MS);
  };

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
        const holder: LockHolder = {
          pid: process.pid,
          startTime: me.startTime,
          bootId: me.bootId,
          pidNs: me.pidNs,
          host: me.host,
          token,
          startedAt: now()
        };
        writeSync(fd, JSON.stringify(holder));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    }
    const holder = readHolder(path);
    let stale: boolean;
    if (holder) {
      stale = holderGone(holder) || now() - holder.startedAt > (options.staleMs ?? LOCK_STALE_MS);
    } else {
      const age = heartbeatAge();
      if (age === undefined) continue; // released meanwhile: try again at once
      stale = age > FRESH_MS;
    }
    if (stale) {
      breakLock(path, holder);
      continue;
    }
    if (now() >= deadline) {
      throw new LockError(
        `another pipulse tls command is running (pid ${holder?.pid ?? '?'}${
          holder?.host && holder.host !== me.host ? ` on ${holder.host}` : ''
        }); try again when it has finished`
      );
    }
    await sleep(500);
  }
  // A holder this process can't be seen by (another container) relies on this.
  const heartbeat = setInterval(() => {
    try {
      const at = new Date();
      utimesSync(path, at, at);
    } catch {
      // The lock was removed or broken; the release below notices.
    }
  }, options.heartbeatMs ?? LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    if (readHolder(path)?.token === token) rmSync(path, { force: true });
  }
}
