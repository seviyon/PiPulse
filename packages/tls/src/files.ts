import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export class TlsFileError extends Error {
  override name = 'TlsFileError';
}

/**
 * operator: the operator's own paths — symlinks allowed (secret volumes,
 * certbot's live/ links), owner not checked, a secret must not be
 * world-readable. generated: PiPulse's own files — no symlink, a regular
 * file no more permissive than `maxMode`, with the expected owner.
 */
export type ReadPolicy =
  | { kind: 'operator'; secret: boolean }
  | { kind: 'generated'; maxMode: number; uid?: number; gid?: number };

const MAX_BYTES = 64 * 1024;

function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOENT':
      return 'file not found';
    case 'EACCES':
      return 'not readable by this user';
    case 'ELOOP':
    case 'EMLINK':
      return 'is a symbolic link, which is not allowed here';
    default:
      return `can't be opened (${code ?? 'error'})`;
  }
}

/**
 * Opens `path`, checks the open file (not the path, so nothing can be swapped
 * in between) and reads that same descriptor. O_NONBLOCK keeps a FIFO from
 * blocking the open; it is then refused as not a regular file. Errors name
 * `what` (a setting or file name), never the contents.
 */
export function readSecureFile(path: string, policy: ReadPolicy, what: string): string {
  const flags =
    constants.O_RDONLY |
    constants.O_NONBLOCK |
    (policy.kind === 'generated' ? constants.O_NOFOLLOW : 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    throw new TlsFileError(`${what}: ${reason(error)}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TlsFileError(`${what}: not a regular file`);
    if (stat.size > MAX_BYTES) throw new TlsFileError(`${what}: larger than 64 KiB`);
    const mode = stat.mode & 0o777;
    if (policy.kind === 'operator') {
      if (policy.secret && (mode & 0o004) !== 0) {
        throw new TlsFileError(`${what}: readable by every user; chmod o-r it`);
      }
    } else {
      if ((mode & ~policy.maxMode) !== 0) {
        throw new TlsFileError(
          `${what}: permissions ${mode.toString(8)} are broader than ${policy.maxMode.toString(8)}`
        );
      }
      if (policy.uid !== undefined && stat.uid !== policy.uid) {
        throw new TlsFileError(`${what}: owned by uid ${stat.uid}, expected ${policy.uid}`);
      }
      if (policy.gid !== undefined && stat.gid !== policy.gid) {
        throw new TlsFileError(`${what}: group ${stat.gid}, expected ${policy.gid}`);
      }
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A cheap change signature for the reload poll: inode, size and mtime of each
 * file, following symlinks (a retargeted link changes it), 'missing' for a
 * file that can't be stat'ed.
 */
export function statSignature(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const stat = statSync(path);
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode & 0o777}:${stat.uid}:${stat.gid}`;
      } catch {
        return 'missing';
      }
    })
    .join('|');
}

export interface Owner {
  uid: number;
  gid: number;
}

export type FsPoint = 'create' | 'write' | 'fsync' | 'rename' | 'fsync-dir' | 'mkdir' | 'remove';
/** Called before each step that changes the disk; tests throw SimulatedCrash from it. */
export type FsHook = (point: FsPoint, path: string) => void;

/** Thrown by a test hook to stop a write the way a crash would: nothing is cleaned up. */
export class SimulatedCrash extends Error {
  override name = 'SimulatedCrash';
}

const TEMP = /^\..+\.[0-9a-f]{12}\.tmp$/;

export function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Removes temp files a crashed writeAtomic left behind. Only for a caller that
 * holds the TLS lock (mutating commands): it has no age check, so a read-only
 * command that called it could delete a running writer's temp file.
 */
export function cleanTemp(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (TEMP.test(name)) rmSync(join(dir, name), { force: true });
}

/**
 * Replaces `path` so a reader sees the old file or the new one, never a mix,
 * and never with broader permissions: the temp file is created O_EXCL|
 * O_NOFOLLOW (0600), gets its owner and final mode before any content, is
 * written and fsync'd, renamed over `path`, and the directory is fsync'd.
 * The owner is changed only when it differs: in a setgid directory the group
 * is already right, so root without CAP_CHOWN (the renew unit, the sidecar)
 * never needs it.
 */
export function writeAtomic(
  path: string,
  data: string,
  options: { mode: number; owner?: Owner | undefined; hook?: FsHook | undefined }
): void {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const hook = options.hook ?? (() => {});
  const cleanUp = (error: unknown) => {
    if (!(error instanceof SimulatedCrash)) rmSync(temp, { force: true });
  };
  hook('create', temp);
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const stat = fstatSync(fd);
    if (options.owner && (stat.uid !== options.owner.uid || stat.gid !== options.owner.gid)) {
      fchownSync(fd, options.owner.uid, options.owner.gid);
    }
    fchmodSync(fd, options.mode);
    hook('write', temp);
    // writeFileSync loops until every byte is written; a bare writeSync may write less
    // without throwing, and a cut-off file would be renamed over a good ca.key or leaf.pem.
    writeFileSync(fd, data);
    hook('fsync', temp);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    cleanUp(error);
    throw error;
  }
  closeSync(fd);
  try {
    hook('rename', path);
    renameSync(temp, path);
  } catch (error) {
    cleanUp(error);
    throw error;
  }
  hook('fsync-dir', dir);
  syncDir(dir);
}

/** rename + fsync of the target's directory, for moving whole directories in the journal. */
export function renameDurable(from: string, to: string, hook?: FsHook | undefined): void {
  hook?.('rename', to);
  renameSync(from, to);
  hook?.('fsync-dir', dirname(to));
  syncDir(dirname(to));
}

export function removeTree(path: string, hook?: FsHook | undefined): void {
  hook?.('remove', path);
  rmSync(path, { recursive: true, force: true });
}

/**
 * Makes `path` a real directory (never a symlink) with exactly `mode`
 * (setgid included) and `owner`, creating it if needed. An existing
 * directory is tightened or loosened to `mode`: these directories are
 * PiPulse's own.
 */
export function ensureDir(
  path: string,
  options: { mode: number; owner?: Owner | undefined; hook?: FsHook | undefined }
): void {
  try {
    options.hook?.('mkdir', path);
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Everything below goes through one descriptor opened without following a symlink, so a
  // directory swapped for a symlink after the check can't have its target chmod'ed or chown'ed.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR')
      throw new TlsFileError(`${path} is not a directory`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    // Mode first, then owner, and no chmod when the mode already matches: a process without
    // CAP_FSETID that isn't in the directory's group (the Docker init and sidecar hold only
    // CHOWN or nothing) has the kernel drop setgid from every chmod. Applied while the group is
    // still root's it keeps it, and chown never clears setgid on a directory.
    if ((stat.mode & 0o7777) !== options.mode) fchmodSync(fd, options.mode);
    if (options.owner && (stat.uid !== options.owner.uid || stat.gid !== options.owner.gid)) {
      fchownSync(fd, options.owner.uid, options.owner.gid);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether `path` exists (lstat, so a dangling symlink does). False only for ENOENT: any
 * other failure (EACCES, EIO, a missing volume) is thrown, never read as "absent". Used
 * where "absent" would let a step be skipped or a second CA be made.
 */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
