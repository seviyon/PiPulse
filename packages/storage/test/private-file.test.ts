import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertSample, openDb } from '../src/index.js';
import { createPrivate, tightenPrivate } from '../src/private-file.js';

let dir: string;
let oldUmask: number;
let oldCwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-db-'));
  // A path that is not a file must not leave one behind: relative names land here, not in the repo.
  oldCwd = process.cwd();
  process.chdir(dir);
  // The loosest umask there is: the file must be private because we made it so, not because of it.
  oldUmask = process.umask(0o000);
});
afterEach(() => {
  process.chdir(oldCwd);
  process.umask(oldUmask);
  rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe('the database file is private', () => {
  it('is 0600 when openDb creates it, WAL files included, even under umask 000', () => {
    const path = join(dir, 'pipulse.sqlite');
    const db = openDb(path);
    insertSample(db, { ts: 1, metric: 'a', value: 1 });
    expect(mode(path)).toBe(0o600);
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(mode(`${path}-wal`)).toBe(0o600);
    expect(mode(`${path}-shm`)).toBe(0o600);
    db.close();
  });

  it('creates a new file private by itself, before SQLite touches it', () => {
    const path = join(dir, 'new.sqlite');
    createPrivate(path);
    expect(existsSync(path)).toBe(true);
    expect(mode(path)).toBe(0o600);
    expect(statSync(path).size).toBe(0);
    // An existing file is not truncated or re-moded by it.
    writeFileSync(path, 'data');
    chmodSync(path, 0o640);
    createPrivate(path);
    expect(statSync(path).size).toBe(4);
    expect(mode(path)).toBe(0o640);
  });

  it('tightens a file an older version left readable, and its WAL and shared-memory files', () => {
    const path = join(dir, 'pipulse.sqlite');
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      writeFileSync(file, 'x');
      chmodSync(file, 0o644);
    }
    tightenPrivate(path);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(mode(file)).toBe(0o600);
  });

  it('openDb tightens what an older version left', () => {
    const path = join(dir, 'pipulse.sqlite');
    openDb(path).close();
    chmodSync(path, 0o644);
    openDb(path).close();
    expect(mode(path)).toBe(0o600);
  });

  it('leaves a file that is already stricter alone', () => {
    const path = join(dir, 'pipulse.sqlite');
    openDb(path).close();
    chmodSync(path, 0o400);
    tightenPrivate(path);
    expect(mode(path)).toBe(0o400);
  });

  it('does nothing for an in-memory database or a URI: no file is made, none is changed', () => {
    expect(() => openDb(':memory:').close()).not.toThrow();
    createPrivate(':memory:');
    createPrivate('file:memdb?mode=memory');
    expect(existsSync(join(dir, ':memory:'))).toBe(false);
    expect(existsSync(join(dir, 'file:memdb?mode=memory'))).toBe(false);
    // A file that happens to have such a name is not ours to change.
    for (const name of [':memory:', 'file:x']) {
      writeFileSync(join(dir, name), 'x');
      chmodSync(join(dir, name), 0o644);
      tightenPrivate(name);
      expect(mode(join(dir, name))).toBe(0o644);
    }
  });

  it('a missing file is nothing to tighten', () => {
    expect(() => tightenPrivate(join(dir, 'nope.sqlite'))).not.toThrow();
    expect(existsSync(join(dir, 'nope.sqlite'))).toBe(false);
  });

  it('leaves a missing folder for SQLite to report', () => {
    expect(() => openDb(join(dir, 'no-such-folder', 'pipulse.sqlite'))).toThrow();
  });

  it('a mode problem never stops the server from starting: a file that cannot be changed is left', () => {
    const path = join(dir, 'pipulse.sqlite');
    openDb(path).close();
    chmodSync(path, 0o644);
    // Making the directory read-only does not stop chmod of an owned file; a path that does not
    // exist for stat is the failure we can produce portably.
    expect(() => tightenPrivate(`${path}-missing`)).not.toThrow();
  });
});
