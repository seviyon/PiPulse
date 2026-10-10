import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureDir,
  readSecureFile,
  removeTree,
  renameDurable,
  syncDir,
  writeAtomic,
  type FsPoint
} from '../src/files.js';
import { tempDir } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const generated = { kind: 'generated', maxMode: 0o640 } as const;
const isRoot = process.getuid?.() === 0;

describe('writeAtomic cleans up after a real error', () => {
  // The existing "real error" test makes the directory read-only, so openSync fails before a
  // temp file exists and the cleanup code never runs. These fail after the temp file is made.
  it('removes the temp file when a step after creating it throws', () => {
    for (const failAt of ['write', 'fsync', 'rename'] as const) {
      expect(() =>
        writeAtomic(join(dir, 'target'), 'x', {
          mode: 0o600,
          hook: (point) => {
            if (point === failAt) throw new Error(`fail at ${failAt}`);
          }
        })
      ).toThrow(`fail at ${failAt}`);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('removes the temp file when the rename itself fails, and leaves the target alone', () => {
    const target = join(dir, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'precious');
    expect(() => writeAtomic(target, 'x', { mode: 0o600 })).toThrow();
    expect(readdirSync(dir)).toEqual(['target']);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('precious');
  });
});

describe('readSecureFile, other refusals', () => {
  it('refuses a FIFO without blocking', () => {
    const fifo = join(dir, 'pipe.pem');
    execFileSync('mkfifo', [fifo]);
    for (const policy of [{ kind: 'operator', secret: false }, generated] as const) {
      expect(() => readSecureFile(fifo, policy, 'PIPULSE_TLS_CERT')).toThrow(
        'PIPULSE_TLS_CERT: not a regular file'
      );
    }
  });

  it.skipIf(isRoot)('names an unreadable file without leaking anything else', () => {
    const path = join(dir, 'locked.pem');
    writeFileSync(path, 'secret contents');
    chmodSync(path, 0o000);
    try {
      expect(() => readSecureFile(path, generated, 'leaf.pem')).toThrow(
        'leaf.pem: not readable by this user'
      );
    } finally {
      chmodSync(path, 0o600);
    }
  });

  // Documents a limit, not a goal: O_NOFOLLOW covers the last path component only, so a
  // symlinked parent directory is followed. The generated folders are root-owned, which is
  // what keeps this from mattering. If the policy ever walks the path, change this test.
  it('follows a symlinked parent directory under the generated policy (current behaviour)', () => {
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'leaf.pem'), 'cert');
    chmodSync(join(dir, 'real', 'leaf.pem'), 0o640);
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(readSecureFile(join(dir, 'link', 'leaf.pem'), generated, 'leaf.pem')).toBe('cert');
  });
});

describe('renameDurable', () => {
  it('moves a file or a whole folder and reports the steps in order', () => {
    writeFileSync(join(dir, 'a'), 'one');
    mkdirSync(join(dir, 'tree'));
    writeFileSync(join(dir, 'tree', 'inner'), 'two');
    const seen: [FsPoint, string][] = [];
    const hook = (point: FsPoint, path: string) => seen.push([point, path]);

    renameDurable(join(dir, 'a'), join(dir, 'b'), hook);
    renameDurable(join(dir, 'tree'), join(dir, 'moved'), hook);

    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('one');
    expect(readFileSync(join(dir, 'moved', 'inner'), 'utf8')).toBe('two');
    expect(existsSync(join(dir, 'a'))).toBe(false);
    expect(seen).toEqual([
      ['rename', join(dir, 'b')],
      ['fsync-dir', dir],
      ['rename', join(dir, 'moved')],
      ['fsync-dir', dir]
    ]);
  });

  it('does not touch the destination folder when the hook stops it before the rename', () => {
    writeFileSync(join(dir, 'a'), 'one');
    expect(() =>
      renameDurable(join(dir, 'a'), join(dir, 'b'), () => {
        throw new Error('stop');
      })
    ).toThrow('stop');
    expect(existsSync(join(dir, 'a'))).toBe(true);
    expect(existsSync(join(dir, 'b'))).toBe(false);
  });

  it('throws when the source is missing', () => {
    expect(() => renameDurable(join(dir, 'nope'), join(dir, 'b'))).toThrow(/ENOENT/);
  });
});

describe('removeTree', () => {
  it('removes a nested tree, tells the hook first, and ignores a missing path', () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'f'), 'x');
    const seen: [FsPoint, string][] = [];
    removeTree(join(dir, 'a'), (point, path) => seen.push([point, path]));
    expect(existsSync(join(dir, 'a'))).toBe(false);
    expect(seen).toEqual([['remove', join(dir, 'a')]]);
    expect(() => removeTree(join(dir, 'never-existed'))).not.toThrow();
  });

  it('removes a symlink without following it', () => {
    mkdirSync(join(dir, 'target'));
    writeFileSync(join(dir, 'target', 'keep'), 'x');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    removeTree(join(dir, 'link'));
    expect(existsSync(join(dir, 'link'))).toBe(false);
    expect(readFileSync(join(dir, 'target', 'keep'), 'utf8')).toBe('x');
  });
});

describe('syncDir', () => {
  it('works on a folder and throws on a missing one', () => {
    expect(() => syncDir(dir)).not.toThrow();
    expect(() => syncDir(join(dir, 'nope'))).toThrow(/ENOENT/);
  });
});

describe('ensureDir', () => {
  // A chmod to the mode it already has still bumps ctime. Without CAP_FSETID a process outside
  // the directory's group has the kernel drop setgid from every chmod, so ensureDir must skip
  // the call when nothing changes (the Docker init and sidecar depend on it).
  it('does not chmod a directory that already has the mode', async () => {
    const path = join(dir, 'tls');
    ensureDir(path, { mode: 0o2750 });
    const before = statSync(path).ctimeMs;
    await new Promise((resolve) => setTimeout(resolve, 25));
    ensureDir(path, { mode: 0o2750 });
    expect(statSync(path).ctimeMs).toBe(before);
    expect(statSync(path).mode & 0o7777).toBe(0o2750);
  });

  it('keeps setgid when it only has to change the group to the one it has', () => {
    const path = join(dir, 'tls');
    ensureDir(path, { mode: 0o2750, owner: { uid: process.getuid!(), gid: process.getgid!() } });
    ensureDir(path, { mode: 0o2750, owner: { uid: process.getuid!(), gid: process.getgid!() } });
    expect(statSync(path).mode & 0o7777).toBe(0o2750);
  });
});
