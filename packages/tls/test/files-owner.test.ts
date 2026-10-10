import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDir, writeAtomic } from '../src/files.js';
import { tempDir } from './helpers.js';

// Records every ownership and mode change and applies only the ones that need no privilege,
// so the branches that call chown can be exercised without being root.
const calls = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const uid = process.getuid!();
  const gid = process.getgid!();
  const record =
    (name: string) =>
    (target: unknown, ...args: unknown[]) => {
      calls.list.push(`${name}:${typeof target === 'number' ? 'fd' : 'path'}`);
      return args;
    };
  return {
    ...actual,
    chmodSync: record('chmod'),
    chownSync: record('chown'),
    fchownSync: (fd: number, newUid: number, newGid: number) => {
      calls.list.push('fchown:fd');
      if (newUid === uid && newGid === gid) actual.fchownSync(fd, newUid, newGid);
    }
  };
});

let dir: string;
beforeEach(() => {
  dir = tempDir();
  calls.list = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const me = () => ({ uid: process.getuid!(), gid: process.getgid!() });
const elsewhere = () => ({ uid: process.getuid!() + 1, gid: process.getgid!() + 1 });

describe('writeAtomic ownership', () => {
  it('asks for a new owner only when the temp file has a different one', () => {
    writeAtomic(join(dir, 'same'), 'x', { mode: 0o600, owner: me() });
    expect(calls.list).not.toContain('fchown:fd');
    writeAtomic(join(dir, 'other'), 'x', { mode: 0o600, owner: elsewhere() });
    expect(calls.list.filter((call) => call === 'fchown:fd')).toHaveLength(1);
    expect(readFileSync(join(dir, 'other'), 'utf8')).toBe('x');
  });
});

describe('ensureDir ownership and mode', () => {
  it('changes a directory only through its descriptor, never through the path', () => {
    mkdirSync(join(dir, 'tls'), { mode: 0o755 });
    ensureDir(join(dir, 'tls'), { mode: 0o2750, owner: elsewhere() });
    expect(calls.list).toContain('fchown:fd');
    expect(calls.list.filter((call) => call.endsWith(':path'))).toEqual([]);
    expect(statSync(join(dir, 'tls')).mode & 0o7777).toBe(0o2750);
  });

  it('does not touch the owner of a directory that already has it', () => {
    ensureDir(join(dir, 'tls'), { mode: 0o700, owner: me() });
    ensureDir(join(dir, 'tls'), { mode: 0o700, owner: me() });
    expect(calls.list).not.toContain('fchown:fd');
  });

  // The old lstat-then-chmod(path) followed a symlink that replaced the directory in between.
  it('leaves what a symlink points at alone', () => {
    mkdirSync(join(dir, 'real'), { mode: 0o755 });
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(() => ensureDir(join(dir, 'link'), { mode: 0o700, owner: elsewhere() })).toThrow(
      /not a directory/
    );
    expect(statSync(join(dir, 'real')).mode & 0o777).toBe(0o755);
    expect(calls.list).toEqual([]);
  });

  it('refuses a plain file', () => {
    writeFileSync(join(dir, 'file'), '');
    expect(() => ensureDir(join(dir, 'file'), { mode: 0o700 })).toThrow(/not a directory/);
  });
});
