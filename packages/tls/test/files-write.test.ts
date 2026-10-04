import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedCrash, cleanTemp, ensureDir, writeAtomic, type FsPoint } from '../src/files.js';
import { tempDir } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const me = () => ({ uid: process.getuid!(), gid: process.getgid!() });

describe('writeAtomic', () => {
  it('writes every byte of a large file', () => {
    const data = 'x'.repeat(8 * 1024 * 1024);
    const path = join(dir, 'big');
    writeAtomic(path, data, { mode: 0o600 });
    expect(statSync(path).size).toBe(data.length);
  });

  it('writes the content with exactly the requested mode, whatever the umask', () => {
    const old = process.umask(0o000);
    try {
      writeAtomic(join(dir, 'leaf.pem'), 'secret', { mode: 0o640, owner: me() });
    } finally {
      process.umask(old);
    }
    expect(readFileSync(join(dir, 'leaf.pem'), 'utf8')).toBe('secret');
    expect(statSync(join(dir, 'leaf.pem')).mode & 0o7777).toBe(0o640);
  });

  it('has the final mode set before any byte is written', () => {
    const seen: { point: FsPoint; mode: number; size: number }[] = [];
    writeAtomic(join(dir, 'ca.key'), 'key material', {
      mode: 0o600,
      hook: (point, path) => {
        if (point === 'write' || point === 'fsync') {
          const s = statSync(path);
          seen.push({ point, mode: s.mode & 0o777, size: s.size });
        }
      }
    });
    expect(seen[0]).toEqual({ point: 'write', mode: 0o600, size: 0 });
  });

  it('replaces the old file in one step: a reader sees old or new, never a mix', () => {
    writeAtomic(join(dir, 'f'), 'old', { mode: 0o644 });
    writeAtomic(join(dir, 'f'), 'new', {
      mode: 0o644,
      hook: (point) => {
        if (point === 'rename') expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('old');
      }
    });
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  it('a crash leaves only a temp file, which cleanTemp removes', () => {
    let tempPath = '';
    expect(() =>
      writeAtomic(join(dir, 'g'), 'x', {
        mode: 0o600,
        hook: (point, path) => {
          if (point === 'fsync') {
            tempPath = path;
            throw new SimulatedCrash('boom');
          }
        }
      })
    ).toThrow(SimulatedCrash);
    expect(existsSync(join(dir, 'g'))).toBe(false);
    expect(existsSync(tempPath)).toBe(true);
    cleanTemp(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  // Root ignores directory permissions, so this can only fail as a normal user.
  it.skipIf(process.getuid?.() === 0)(
    'cleans up after a real error (not a simulated crash)',
    () => {
      chmodSync(dir, 0o500);
      try {
        expect(() => writeAtomic(join(dir, 'h'), 'x', { mode: 0o600 })).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(readdirSync(dir)).toEqual([]);
    }
  );
});

describe('ensureDir', () => {
  it('creates a directory with the exact mode, setgid included', () => {
    ensureDir(join(dir, 'tls'), { mode: 0o2750, owner: me() });
    expect(statSync(join(dir, 'tls')).mode & 0o7777).toBe(0o2750);
  });
  it('tightens an existing directory', () => {
    mkdirSync(join(dir, 'ca'), { mode: 0o755 });
    ensureDir(join(dir, 'ca'), { mode: 0o700 });
    expect(statSync(join(dir, 'ca')).mode & 0o777).toBe(0o700);
  });
  it('refuses a symlink or a file in the way', () => {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(() => ensureDir(join(dir, 'link'), { mode: 0o700 })).toThrow(/not a directory/);
    writeFileSync(join(dir, 'file'), '');
    expect(() => ensureDir(join(dir, 'file'), { mode: 0o700 })).toThrow(/not a directory/);
    expect(lstatSync(join(dir, 'link')).isSymbolicLink()).toBe(true);
  });
});
