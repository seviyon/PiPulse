import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';

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
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return 'missing';
      }
    })
    .join('|');
}
