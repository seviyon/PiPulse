import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../helpers.js';

// A file that grows after the size check looks small to fstat and is large to read. The race can't
// be timed from outside, so fstat is made to report a small size for a file that is large.
const lie = vi.hoisted(() => ({
  size: undefined as number | undefined,
  open: new Set<number>()
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...args);
      lie.open.add(fd);
      return fd;
    },
    closeSync: (fd: number) => {
      lie.open.delete(fd);
      real.closeSync(fd);
    },
    fstatSync: (fd: number) => {
      const stat = real.fstatSync(fd);
      const size = lie.size;
      return size === undefined
        ? stat
        : new Proxy(stat, {
            get: (target, key) => (key === 'size' ? size : Reflect.get(target, key, target))
          });
    }
  };
});

const { readAtMost, readSecureFile } = await import('../../src/common/files.js');

let dir: string;
beforeEach(() => {
  dir = tempDir();
  lie.size = undefined;
  lie.open.clear();
});
afterEach(() => {
  lie.size = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const operator = { kind: 'operator', secret: false } as const;
const CAP = 64 * 1024;

describe('readSecureFile reads at most its cap', () => {
  it('refuses a file larger than the cap that fstat reported as small', () => {
    const path = join(dir, 'grown.pem');
    writeFileSync(path, 'x'.repeat(CAP + 1));
    lie.size = 10;
    expect(() => readSecureFile(path, operator, 'PIPULSE_TLS_CERT')).toThrow(
      /^PIPULSE_TLS_CERT: larger than 64 KiB/
    );
  });

  it('reads a file of exactly the cap', () => {
    const path = join(dir, 'exact.pem');
    writeFileSync(path, 'x'.repeat(CAP));
    expect(readSecureFile(path, operator, 'PIPULSE_TLS_CERT')).toHaveLength(CAP);
  });

  it('refuses a file one byte over the cap when fstat is honest', () => {
    const path = join(dir, 'over.pem');
    writeFileSync(path, 'x'.repeat(CAP + 1));
    expect(() => readSecureFile(path, operator, 'PIPULSE_TLS_CERT')).toThrow(/larger than 64 KiB/);
  });
});

describe('readSecureFile closes its descriptor', () => {
  // Opened by the code under test and never closed would leak one descriptor per poll.
  const policy = { kind: 'operator', secret: true } as const;

  it('after a read, and after each way of refusing a file', () => {
    const ok = join(dir, 'ok.pem');
    writeFileSync(ok, 'cert');
    expect(readSecureFile(ok, operator, 'c')).toBe('cert');
    expect(lie.open.size).toBe(0);

    const big = join(dir, 'big.pem');
    writeFileSync(big, 'x'.repeat(CAP + 1));
    expect(() => readSecureFile(big, operator, 'c')).toThrow(/larger than/);
    expect(lie.open.size).toBe(0);

    const open = join(dir, 'open.key');
    writeFileSync(open, 'key', { mode: 0o644 });
    chmodSync(open, 0o644);
    expect(() => readSecureFile(open, policy, 'k')).toThrow(/readable by every user/);
    expect(lie.open.size).toBe(0);

    expect(() => readSecureFile(dir, operator, 'd')).toThrow(/not a regular file/);
    expect(lie.open.size).toBe(0);
  });
});

describe('readAtMost', () => {
  const open = (name: string, bytes: number) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'y'.repeat(bytes));
    return openSync(path, 'r');
  };

  it('returns the text of a file up to the cap', () => {
    const fd = open('a', 5);
    try {
      expect(readAtMost(fd, 5)).toBe('yyyyy');
    } finally {
      closeSync(fd);
    }
  });

  it('returns undefined for a file longer than the cap', () => {
    const fd = open('b', 6);
    try {
      expect(readAtMost(fd, 5)).toBeUndefined();
    } finally {
      closeSync(fd);
    }
  });

  it('returns an empty string for an empty file', () => {
    const fd = open('c', 0);
    try {
      expect(readAtMost(fd, 5)).toBe('');
    } finally {
      closeSync(fd);
    }
  });
});
