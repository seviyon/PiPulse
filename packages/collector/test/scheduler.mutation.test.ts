import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHistory, openDb, type PiPulseDb } from '@pipulse/storage';
import { runOnce, startScheduler, type CollectorPlugin } from '../src/index.js';

function fakePlugin(id: string, intervalMs: number, collect: () => Promise<number | null>) {
  return { id, label: id, unit: 'x', intervalMs, apiVersion: 1, collect } as CollectorPlugin;
}

let db: PiPulseDb;

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  db = openDb(':memory:');
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

const stored = (metric: string) => getHistory(db, metric, 0, Number.MAX_SAFE_INTEGER);

describe('what is stored', () => {
  it.each([NaN, Infinity, -Infinity])('skips a reading of %s', async (value) => {
    await runOnce(db, [fakePlugin('odd', 1000, async () => value)]);
    expect(stored('odd')).toEqual([]);
  });

  it('keeps a reading of 0', async () => {
    await runOnce(db, [fakePlugin('zero', 1000, async () => 0)]);
    expect(stored('zero').map((s) => s.value)).toEqual([0]);
  });

  it('does not throw when a read fails and nobody listens for errors', async () => {
    const failing = fakePlugin('failing', 1000, async () => {
      throw new Error('sensor gone');
    });
    await expect(runOnce(db, [failing])).resolves.toBeUndefined();
  });

  it('does not throw when a sample listener fails and nobody listens for errors', async () => {
    const scheduler = startScheduler(db, [fakePlugin('ok', 1000, async () => 1)], {
      onSample: () => {
        throw new Error('listener broke');
      }
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(scheduler.stop()).resolves.toBe(true);
    expect(stored('ok')).toHaveLength(1);
  });
});

describe('startScheduler validation', () => {
  it('lists every problem of a plugin, separated by "; "', () => {
    const bad = { id: 'BAD', label: '', unit: 'x', intervalMs: 1000, apiVersion: 1, collect() {} };
    expect(() => startScheduler(db, [bad as unknown as CollectorPlugin])).toThrow(
      'Invalid plugin "BAD": id must be lowercase snake_case; label must not be empty'
    );
  });
});

describe('stop', () => {
  it('with no timeout waits as long as a read takes', async () => {
    let finish: (value: number) => void = () => {};
    const slow = fakePlugin('slow', 60_000, () => new Promise<number>((r) => (finish = r)));
    const scheduler = startScheduler(db, [slow]);

    let result: boolean | undefined;
    void scheduler.stop().then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(5000);
    expect(result).toBeUndefined();

    finish(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(true);
  });

  it('with a timeout leaves no timer behind once the reads have settled', async () => {
    const scheduler = startScheduler(db, [fakePlugin('quick', 1000, async () => 1)]);
    await expect(scheduler.stop(60_000)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
