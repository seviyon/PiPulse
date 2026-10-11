import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  futimesSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathExists } from './files.js';
import type { Layout } from './layout.js';
import { pidAlive, pidNamespace, processIdentity } from './proc.js';

export const LOCK_FILE = '.pipulse-tls.lock';
export const LOCK_WAIT_MS = 30_000;
/** Longer than any command holds it (enable waits for health twice, 30 s each). */
export const LOCK_STALE_MS = 15 * 60_000;
/** A lock file whose content isn't readable yet is being written, for this long. */
const FRESH_MS = 5_000;
/** A breaker's turn file that can't be read, or whose owner can't be seen, and is older than this was left by a breaker that died: breaking takes microseconds. */
export const BREAK_MUTEX_STALE_MS = 10_000;
/** The holder touches the lock this often; a holder we can't see in /proc is judged by it. */
export const LOCK_HEARTBEAT_MS = 20_000;
/** A holder in another PID namespace (another container) looks gone after this long without a heartbeat. */
export const LOCK_REMOTE_STALE_MS = 90_000;
/**
 * ...but only if its heartbeat then stays unchanged for this long on the waiter's own
 * monotonic clock: a forward wall-clock jump (NTP on a Pi without an RTC) makes every
 * heartbeat look old until the holder's next one, which arrives within a heartbeat period.
 */
export const LOCK_OBSERVE_MS = 2 * LOCK_HEARTBEAT_MS + 5_000;

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

/**
 * Refreshes the lock's mtime only while it still carries our token. A lock that was broken and
 * retaken belongs to someone else; touching it would keep a dead new holder looking alive. The
 * check and the touch go through one descriptor, so a break renaming the file aside in between
 * cannot redirect the touch onto a newer lock.
 */
function touchIfMine(path: string, token: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = JSON.parse(readFileSync(fd, 'utf8')) as Partial<LockHolder>;
    if (value.token !== token) return;
    const at = new Date();
    futimesSync(fd, at, at);
  } finally {
    closeSync(fd);
  }
}

/** The holder's pid, checked against /proc, for a holder in our own PID namespace. */
const localHolderAlive = (holder: LockHolder) => {
  const identity = processIdentity(holder.pid);
  if (identity && holder.startTime !== null) return identity.startTime === holder.startTime; // pid reuse is caught
  return pidAlive(holder.pid);
};

export interface LockOptions {
  /**
   * Called when the command ends and the lock file is no longer ours: it was broken as stale
   * and taken by someone else while the command ran, so two commands may have overlapped.
   * The default warns on stderr.
   */
  onLost?: () => void;
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
  /** A monotonic clock in ms (tests replace it); wall-clock jumps must not decide who holds the lock. */
  monotonic?: () => number;
}

/** Whether the lock file's content, read through `aside`, is what the waiter judged stale. */
function matchesJudgement(aside: string, judged: LockHolder | undefined): boolean {
  const taken = readHolder(aside);
  // A lock whose content can't be read matches an unreadable judgement (null === null), so the
  // token alone can't tell the stale file from a new one that its owner has created but not yet
  // written. The mtime is shared with the lock, and a fresh one means it is somebody's new lock.
  if (taken === undefined) {
    try {
      if (Date.now() - statSync(aside).mtimeMs <= FRESH_MS) return false;
    } catch {
      // can't tell: treat as not fresh
    }
  }
  return (taken?.token ?? null) === (judged?.token ?? null);
}

/**
 * Clears a lock judged stale without trusting that judgement blindly. The lock is first
 * linked to a second name and read there, while it stays in place: if it turns out to be a
 * different holder's (somebody broke the stale one and took a fresh lock meanwhile) nothing
 * has moved, so no third process can take the path and two holders never run at once. Only
 * when it is the judged lock is it renamed away, and the inode is compared with the linked
 * copy: if the lock was released and retaken in between, the newer lock is put back.
 *
 * Only one process runs this at a time (breakLock holds the breakers' mutex), so two waiters
 * that judged the same dead holder can no longer both act, with the second moving the first's
 * brand-new lock aside while a third takes the empty path. What remains is a judged holder that
 * is still alive and releases during the break, and only for a holder that could not be verified
 * (see holderGone): its displaced successor then finds out at release. Filesystems without hard
 * links use breakLockByRename().
 */
function breakJudged(path: string, judged: LockHolder | undefined): void {
  const copy = `${path}.stale-${randomBytes(6).toString('hex')}`;
  try {
    linkSync(path, copy);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EMLINK') {
      return breakLockByRename(path, judged);
    }
    throw error;
  }
  const aside = `${path}.stale-${randomBytes(6).toString('hex')}`;
  try {
    if (!matchesJudgement(copy, judged)) return;
    try {
      renameSync(path, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      if (statSync(aside).ino !== statSync(copy).ino) putBack(aside, path);
    } finally {
      rmSync(aside, { force: true });
    }
  } finally {
    rmSync(copy, { force: true });
  }
}

interface BreakerContext {
  /** What this process is (default: localIdentity()). */
  identity?: LocalIdentity;
  /** Overrides the check that an owner in our own PID namespace is still running. */
  alive?: (holder: LockHolder) => boolean;
}

/** `<lock>.breaking.<n>` — breaker turn number n. */
const turnPath = (path: string, n: number) => `${path}.breaking.${n}`;

/** The turn numbers present beside the lock, ascending. */
function turnsOf(path: string): number[] {
  const prefix = `${basename(path)}.breaking.`;
  const turns: number[] = [];
  for (const name of readdirSync(dirname(path))) {
    if (name.startsWith(prefix) && /^\d{1,15}$/.test(name.slice(prefix.length)))
      turns.push(Number(name.slice(prefix.length)));
  }
  return turns.sort((a, b) => a - b);
}

/**
 * Whether the newest turn can be taken over: its breaker gave it back ("released"), or is gone.
 * An owner this process can see (same PID namespace) is judged by its pid and start time, never
 * by age: a breaker that is merely stalled (a stopped process, a slow SD card) keeps its turn.
 * Only an owner that can't be seen (another container, or a file that can't be read, such as one
 * whose creator died before writing it) is judged by the file's age, in either direction (a
 * clock stepped back leaves a leftover dated in the future).
 */
function turnFree(file: string, context: BreakerContext): boolean {
  let seen: Stats;
  let text: string;
  try {
    seen = statSync(file);
    text = readFileSync(file, 'utf8');
  } catch {
    return true; // gone
  }
  try {
    if ((JSON.parse(text) as { released?: unknown }).released === true) return true;
  } catch {
    // unreadable: judged below
  }
  const me = context.identity ?? localIdentity();
  const owner = readHolder(file);
  if (owner) {
    if (owner.bootId !== null && me.bootId !== null && owner.bootId !== me.bootId) return true;
    const sameNamespace =
      owner.pidNs !== null && me.pidNs !== null ? owner.pidNs === me.pidNs : owner.host === me.host;
    if (sameNamespace) return !(context.alive ?? localHolderAlive)(owner);
  }
  return Math.abs(Date.now() - seen.mtimeMs) > BREAK_MUTEX_STALE_MS;
}

/** Where "false" sits in a turn file ({"released":false,...}): release overwrites it in place with "true ". */
const RELEASED_AT = '{"released":'.length;

/**
 * Takes a turn at breaking, so only one breaker acts at a time. A turn is a file numbered one
 * more than the newest, made with O_EXCL: of any number of breakers that find the newest turn
 * free, exactly one creates the next, and the others answer 'busy' and look again.
 *
 * Nothing is deleted to make room (a leftover of a breaker that died is simply outnumbered), and
 * the newest turn is never removed, only marked released, so numbers never restart. The one way
 * a number below the newest can be free to create again is that a higher one was made first (the
 * winner tidies older turns after taking its own): so after making ours the folder is listed
 * again, and if a higher number is there our listing was out of date and we step aside. Turn
 * files are not to be deleted while commands run (purge and uninstall remove the whole folder).
 *
 * A turn's age (for an owner we can't see) is the wall clock's: a forward jump can make a live
 * foreign turn look old for the few microseconds a break takes. The main lock watches a heartbeat
 * on the monotonic clock for that; here the window is too small to be worth a heartbeat.
 */
function takeBreakerMutex(path: string, context: BreakerContext): (() => void) | 'busy' {
  const newest = turnsOf(path).at(-1) ?? 0;
  if (newest > 0 && !turnFree(turnPath(path, newest), context)) return 'busy';
  const number = newest + 1;
  const mine = turnPath(path, number);
  let fd: number;
  try {
    fd = openSync(
      mine,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return 'busy'; // another breaker took this number first
  }
  const giveUp = () => {
    closeSync(fd);
    rmSync(mine, { force: true });
  };
  try {
    const me = context.identity ?? localIdentity();
    writeSync(
      fd,
      JSON.stringify({
        released: false,
        pid: process.pid,
        ...me,
        token: randomBytes(8).toString('hex'),
        startedAt: Date.now()
      })
    );
  } catch (error) {
    giveUp(); // an empty turn would hold every other breaker off for a while; older ones are still there
    throw error;
  }
  const all = turnsOf(path);
  if (all.some((n) => n > number)) {
    giveUp(); // our listing was old: a higher turn exists and its breaker is at work
    return 'busy';
  }
  for (const older of all) if (older < number) rmSync(turnPath(path, older), { force: true });
  // Nobody else is breaking while we hold a turn, so copies a killed breaker left are garbage.
  const stale = `${basename(path)}.stale-`;
  for (const name of readdirSync(dirname(path))) {
    if (name.startsWith(stale)) rmSync(join(dirname(path), name), { force: true });
  }
  return () => {
    // Say so in the file we made (through its descriptor: by name it may be somebody else's by
    // now), in place and the same length, so there is nothing to allocate and nothing to fail.
    try {
      writeSync(fd, 'true ', RELEASED_AT);
    } catch {
      // A turn that can't be released is freed when this process ends, by the owner check.
    } finally {
      closeSync(fd);
    }
  };
}

/**
 * Clears a lock judged stale, one breaker at a time: 'busy' when another is at it (the caller
 * waits a moment and looks again), 'done' otherwise (whether or not the lock was still the one
 * judged: breakJudged leaves a different holder's lock where it is). Without the turn-taking,
 * waiters that all judged the same dead holder could each move a newer lock aside in turn, and a
 * process arriving in the gap would take the lock while its owner still ran.
 */
export function breakLock(
  path: string,
  judged: LockHolder | undefined,
  context: BreakerContext = {}
): 'done' | 'busy' {
  const release = takeBreakerMutex(path, context);
  if (release === 'busy') return 'busy';
  try {
    breakJudged(path, judged);
  } finally {
    release();
  }
  return 'done';
}

/** link() refuses to overwrite, so a lock somebody took meanwhile is never replaced. */
function putBack(aside: string, path: string): void {
  try {
    linkSync(aside, path);
  } catch {
    // Somebody already took a newer lock; the one we moved is gone. Its holder will see
    // at release that the file isn't theirs.
  }
}

/** breakLock for a filesystem that can't hard-link: rename first, judge, put back if wrong. */
function breakLockByRename(path: string, judged: LockHolder | undefined): void {
  const aside = `${path}.stale-${randomBytes(6).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    if (!matchesJudgement(aside, judged)) putBack(aside, path);
  } finally {
    rmSync(aside, { force: true });
  }
}

function warnLockLost(): void {
  process.stderr.write(
    'warning: the pipulse tls lock was taken over while this command ran, so another ' +
      'command may have run at the same time; check `pipulse tls status`\n'
  );
}

/**
 * Runs `fn` holding the one pipulse tls lock, so CA transactions, renewals and
 * mode switches from different processes (a manual new-ca, the hourly timer,
 * setup, the sidecar) never interleave. A holder in our PID namespace is
 * judged by its pid and start time; one in another namespace (another
 * container on a shared volume) or on another boot by its heartbeat, the lock
 * file's mtime. A lock whose holder is gone, or older than staleMs, is cleared;
 * a live holder is waited for up to waitMs, then refused with a LockError.
 * Released in `finally` only if the file still carries our token; if it doesn't, `onLost` says so.
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

  const monotonic = options.monotonic ?? (() => performance.now());
  const heartbeatAge = () => {
    try {
      return Date.now() - statSync(path).mtimeMs;
    } catch {
      return undefined; // released meanwhile
    }
  };
  /** What the waiter last saw of a remote holder's heartbeat, and since when (monotonic). */
  let observed: { key: string; since: number } | undefined;
  let observing = false;

  /**
   * Whether the holder is gone. A holder in our own PID namespace is judged by its pid and
   * start time, and a holder that checks out is NEVER broken because of its age: commands
   * legitimately hold the lock across a confirmation prompt and the clock-sync wait, and the
   * wall clock jumps forward on a Pi when NTP syncs. Only when identity can't be verified
   * (no /proc, an old lock file) does the age bound apply. A holder in another namespace is
   * judged by its heartbeat, confirmed by watching the mtime stand still on the monotonic clock.
   */
  const holderGone = (holder: LockHolder): boolean => {
    observing = false;
    if (holder.bootId !== null && me.bootId !== null && holder.bootId !== me.bootId) return true; // before a reboot
    const sameNamespace =
      holder.pidNs !== null && me.pidNs !== null
        ? holder.pidNs === me.pidNs
        : holder.host === me.host;
    if (sameNamespace) {
      if (!(options.alive ?? localHolderAlive)(holder)) return true;
      const verified =
        options.alive !== undefined ||
        (holder.startTime !== null && processIdentity(holder.pid) !== undefined);
      return !verified && now() - holder.startedAt > (options.staleMs ?? LOCK_STALE_MS);
    }
    const age = heartbeatAge();
    if (age === undefined || age <= (options.remoteStaleMs ?? LOCK_REMOTE_STALE_MS)) {
      observed = undefined;
      return false;
    }
    let mtime: string;
    try {
      mtime = String(statSync(path).mtimeMs);
    } catch {
      return false;
    }
    const key = `${holder.token ?? ''}:${mtime}`;
    if (observed?.key !== key) {
      observed = { key, since: monotonic() };
    }
    observing = true;
    return monotonic() - observed.since >= LOCK_OBSERVE_MS;
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
      stale = holderGone(holder);
    } else {
      const age = heartbeatAge();
      if (age === undefined) continue; // released meanwhile: try again at once
      stale = age > FRESH_MS;
    }
    if (stale) {
      observed = undefined;
      // Another waiter is breaking it: give it a moment rather than spin or break it twice, but
      // not past waitMs (a leftover from a dead breaker is cleared on the way).
      if (
        breakLock(path, holder, {
          identity: me,
          ...(options.alive ? { alive: options.alive } : {})
        }) === 'busy'
      ) {
        if (now() >= deadline) {
          throw new LockError(
            'another pipulse tls command is clearing a stale lock; try again in a moment'
          );
        }
        await sleep(10);
      }
      continue;
    }
    // While a remote holder's heartbeat is being watched, the wait is not cut short by waitMs.
    if (now() >= deadline && !observing) {
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
      touchIfMine(path, token);
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
    else (options.onLost ?? warnLockLost)();
  }
}
