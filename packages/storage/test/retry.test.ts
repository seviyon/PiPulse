import { describe, expect, it } from 'vitest';
import { retryWhileLocked } from '../src/retry.js';

describe('retryWhileLocked', () => {
  it('runs a function that works once, without sleeping', () => {
    const slept: number[] = [];
    let runs = 0;
    retryWhileLocked(() => runs++, { sleep: (ms) => slept.push(ms) });
    expect(runs).toBe(1);
    expect(slept).toEqual([]);
  });

  it('tries again, sleeping between tries, while the database is locked or busy', () => {
    const slept: number[] = [];
    let runs = 0;
    retryWhileLocked(
      () => {
        runs++;
        if (runs === 1) throw new Error('database is locked');
        if (runs === 2) throw new Error('SQLITE_BUSY: the database file is busy');
      },
      { sleep: (ms) => slept.push(ms), sleepMs: 7 }
    );
    expect(runs).toBe(3);
    expect(slept).toEqual([7, 7]);
  });

  it('does not hide any other failure, and does not wait for it', () => {
    const slept: number[] = [];
    expect(() =>
      retryWhileLocked(
        () => {
          throw new Error('disk I/O error');
        },
        { sleep: (ms) => slept.push(ms) }
      )
    ).toThrow('disk I/O error');
    expect(slept).toEqual([]);
  });

  it('gives up after its attempts and says what the last try said', () => {
    const slept: number[] = [];
    let runs = 0;
    expect(() =>
      retryWhileLocked(
        () => {
          runs++;
          throw new Error('database is locked');
        },
        { attempts: 4, sleep: (ms) => slept.push(ms) }
      )
    ).toThrow('database is locked');
    expect(runs).toBe(5); // the first try and four more
    expect(slept).toHaveLength(4);
  });

  it('really waits, with the default sleep', () => {
    const started = performance.now();
    let runs = 0;
    retryWhileLocked(
      () => {
        if (runs++ === 0) throw new Error('database is locked');
      },
      { sleepMs: 20 }
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
  });
});
