import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, getHistory, type PiPulseDb } from '@pipulse/storage';
import { startScheduler, type CollectorPlugin } from '../src/index.js';

function fakePlugin(id: string, intervalMs: number, collect: () => Promise<number | null>) {
  return { id, label: id, unit: 'x', intervalMs, apiVersion: 1, collect } as CollectorPlugin;
}

function timestamps(db: PiPulseDb, metric: string): number[] {
  return getHistory(db, metric, 0, Number.MAX_SAFE_INTEGER).map((sample) => sample.ts);
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

describe('startScheduler', () => {
  it('polls each plugin immediately and then on its own interval', async () => {
    const fast = fakePlugin('fast', 1000, async () => 1);
    const slow = fakePlugin('slow', 3000, async () => 2);

    const scheduler = startScheduler(db, [fast, slow]);
    await vi.advanceTimersByTimeAsync(3000);
    await scheduler.stop();

    expect(timestamps(db, 'fast')).toEqual([0, 1000, 2000, 3000]);
    expect(timestamps(db, 'slow')).toEqual([0, 3000]);
  });

  it('skips a tick while the previous collect() is still running', async () => {
    let calls = 0;
    const sluggish = fakePlugin('sluggish', 1000, async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return 1;
    });

    const scheduler = startScheduler(db, [sluggish]);
    await vi.advanceTimersByTimeAsync(3000);
    const stopped = scheduler.stop();
    await vi.advanceTimersByTimeAsync(2500);
    await stopped;

    // Started at 0 (finishes 2500); ticks at 1000 and 2000 are skipped; 3000 starts a new one.
    expect(calls).toBe(2);
  });

  it('keeps polling after a plugin throws, reporting each failure via onError', async () => {
    const flaky = fakePlugin('flaky', 1000, async () => {
      throw new Error('sensor unavailable');
    });
    const onError = vi.fn();

    const scheduler = startScheduler(db, [flaky], { onError });
    await vi.advanceTimersByTimeAsync(2000);
    await scheduler.stop();

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith(flaky, expect.any(Error));
  });

  it('stops polling once stop() resolves', async () => {
    const plugin = fakePlugin('counter', 1000, async () => 1);

    const scheduler = startScheduler(db, [plugin]);
    await vi.advanceTimersByTimeAsync(1000);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(timestamps(db, 'counter')).toEqual([0, 1000]);
  });

  it('stop() waits for in-flight collections so the db can be closed safely', async () => {
    const sluggish = fakePlugin('sluggish', 1000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 1;
    });

    const scheduler = startScheduler(db, [sluggish]);
    const stopped = scheduler.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopped;

    expect(timestamps(db, 'sluggish')).toEqual([500]);
  });

  it('refuses to start with a plugin that violates the contract', () => {
    const broken = fakePlugin('Broken Id', 1000, async () => 1);

    expect(() => startScheduler(db, [broken])).toThrow(
      'Invalid plugin "Broken Id": id must be lowercase snake_case'
    );
  });

  it('refuses to start with two plugins sharing an id', () => {
    const first = fakePlugin('dup', 1000, async () => 1);
    const second = fakePlugin('dup', 2000, async () => 2);

    expect(() => startScheduler(db, [first, second])).toThrow('Duplicate plugin id "dup"');
  });

  it('stop(timeoutMs) resolves true once in-flight collections finish in time', async () => {
    const sluggish = fakePlugin('sluggish', 1000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 1;
    });

    const scheduler = startScheduler(db, [sluggish]);
    const stopped = scheduler.stop(1000);
    await vi.advanceTimersByTimeAsync(500);

    await expect(stopped).resolves.toBe(true);
    expect(timestamps(db, 'sluggish')).toEqual([500]);
  });

  it('stop(timeoutMs) resolves false instead of hanging on a collect() that never settles', async () => {
    const hung = fakePlugin('hung', 1000, () => new Promise<number | null>(() => {}));

    const scheduler = startScheduler(db, [hung]);
    const stopped = scheduler.stop(5000);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(stopped).resolves.toBe(false);
  });
});

describe('startScheduler onSample', () => {
  it('reports each stored sample, after it has been written', async () => {
    const plugin = fakePlugin('live', 1000, async () => 42);
    const seen: { ts: number; metric: string; value: number; storedAtCall: number[] }[] = [];

    const scheduler = startScheduler(db, [plugin], {
      onSample: (sample) => seen.push({ ...sample, storedAtCall: timestamps(db, 'live') })
    });
    await vi.advanceTimersByTimeAsync(1000);
    await scheduler.stop();

    expect(seen).toEqual([
      { ts: 0, metric: 'live', value: 42, storedAtCall: [0] },
      { ts: 1000, metric: 'live', value: 42, storedAtCall: [0, 1000] }
    ]);
  });

  it('is not called for a null reading', async () => {
    const onSample = vi.fn();

    const scheduler = startScheduler(db, [fakePlugin('absent', 1000, async () => null)], {
      onSample
    });
    await scheduler.stop();

    expect(onSample).not.toHaveBeenCalled();
  });

  it('keeps storing and polling when the listener throws, reporting it via onError', async () => {
    const plugin = fakePlugin('live', 1000, async () => 1);
    const onError = vi.fn();

    const scheduler = startScheduler(db, [plugin], {
      onSample: () => {
        throw new Error('listener broke');
      },
      onError
    });
    await vi.advanceTimersByTimeAsync(1000);
    await scheduler.stop();

    expect(timestamps(db, 'live')).toEqual([0, 1000]);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      plugin,
      expect.objectContaining({ message: 'listener broke' })
    );
  });
});
