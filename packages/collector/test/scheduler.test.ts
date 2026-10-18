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
    const stopped = scheduler.stop(2000); // sooner than the collect deadline (3 x the interval)
    await vi.advanceTimersByTimeAsync(2000);

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

/** Stops the scheduler, letting the fake timers run the stop timeout. */
async function drain(scheduler: { stop(timeoutMs?: number): Promise<boolean> }) {
  const stopped = scheduler.stop(1);
  await vi.advanceTimersByTimeAsync(1);
  await stopped;
}

describe('a collect() that never finishes', () => {
  it('is given up on after three intervals, reported, and polled again instead of silencing the metric', async () => {
    let calls = 0;
    const errors: string[] = [];
    const hung = fakePlugin('hung', 1000, () => {
      calls++;
      return new Promise<number | null>(() => {});
    });
    const scheduler = startScheduler(db, [hung], {
      onError: (_plugin, error) => errors.push((error as Error).message)
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toBe(1); // still waiting: ticks are skipped while it is in flight
    await vi.advanceTimersByTimeAsync(2); // 3 s: the deadline passes
    expect(errors).toEqual(['hung: collect() did not finish within 3000 ms']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBeGreaterThanOrEqual(2); // the next tick polls again
    await drain(scheduler);
  });

  it('never stores a late reading from a collect() that was given up on', async () => {
    const finishes: ((value: number) => void)[] = [];
    const late = fakePlugin(
      'late',
      1000,
      () => new Promise<number | null>((resolve) => finishes.push(resolve))
    );
    const scheduler = startScheduler(db, [late], { onError: () => {} });
    await vi.advanceTimersByTimeAsync(3001);
    finishes[0]!(42); // the first, stuck read finally answers, after the deadline
    await vi.advanceTimersByTimeAsync(10);
    expect(timestamps(db, 'late')).toEqual([]);
    await drain(scheduler);
  });

  it('does not touch a collect() that finishes in time, however slow', async () => {
    const slow = fakePlugin('slow', 1000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2900));
      return 7;
    });
    const errors: unknown[] = [];
    const scheduler = startScheduler(db, [slow], { onError: (_p, e) => errors.push(e) });
    await vi.advanceTimersByTimeAsync(2900);
    expect(errors).toEqual([]);
    expect(timestamps(db, 'slow')).toEqual([2900]);
    await drain(scheduler);
  });

  it('stops starting reads while three given-up ones are still hanging, and says so once', async () => {
    let calls = 0;
    const errors: string[] = [];
    const hung = fakePlugin('hung', 1000, () => {
      calls++;
      return new Promise<number | null>(() => {}); // never settles, however long we wait
    });
    const scheduler = startScheduler(db, [hung], {
      onError: (_plugin, error) => errors.push((error as Error).message)
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toBe(3); // not one every deadline for as long as the Pi runs
    expect(errors).toEqual([
      'hung: collect() did not finish within 3000 ms',
      'hung: collect() did not finish within 3000 ms',
      'hung: collect() did not finish within 3000 ms',
      'hung: 3 earlier reads are still hanging; not starting another until one finishes'
    ]);
    await drain(scheduler);
  });

  it('starts reading again as soon as one of the hanging reads settles', async () => {
    const finishes: ((value: number) => void)[] = [];
    const flaky = fakePlugin(
      'flaky',
      1000,
      () => new Promise<number | null>((resolve) => finishes.push(resolve))
    );
    const errors: string[] = [];
    const scheduler = startScheduler(db, [flaky], {
      onError: (_p, e) => errors.push((e as Error).message)
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishes).toHaveLength(3); // capped
    finishes[0]!(1); // the firmware call comes back, long after it was given up on
    await vi.advanceTimersByTimeAsync(1000);
    expect(finishes).toHaveLength(4); // a slot is free: the next tick reads again
    finishes[3]!(5); // and that fresh read is stored as usual
    await vi.advanceTimersByTimeAsync(10);
    expect(timestamps(db, 'flaky')).toHaveLength(1);
    // another stuck read after the recovery is a new episode and is reported again
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors.filter((m) => m.includes('still hanging'))).toHaveLength(2);
    await drain(scheduler);
  });

  it('reports a hanging read without an error handler and still caps the reads', async () => {
    let calls = 0;
    const hung = fakePlugin('hung', 1000, () => {
      calls++;
      return new Promise<number | null>(() => {});
    });
    const scheduler = startScheduler(db, [hung]); // no onError: nothing to tell, nothing to throw
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(3);
    await drain(scheduler);
  });

  it('does not leave the deadline timer running after a read that finished in time', async () => {
    const quick = fakePlugin('quick', 600_000, async () => 1);
    const scheduler = startScheduler(db, [quick], { onError: () => {} });
    await vi.advanceTimersByTimeAsync(1);
    expect(timestamps(db, 'quick')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // the poll interval only
    await drain(scheduler);
  });

  it('counts reads per plugin: one stuck plugin does not stop the others', async () => {
    const stuck = fakePlugin('stuck', 1000, () => new Promise<number | null>(() => {}));
    const fine = fakePlugin('fine', 1000, async () => 1);
    const scheduler = startScheduler(db, [stuck, fine], { onError: () => {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(timestamps(db, 'fine').length).toBeGreaterThan(50);
    await drain(scheduler);
  });

  it('counts a read that rejects late as settled too', async () => {
    const rejections: ((e: Error) => void)[] = [];
    const sick = fakePlugin(
      'sick',
      1000,
      () => new Promise<number | null>((_, reject) => rejections.push(reject))
    );
    const scheduler = startScheduler(db, [sick], { onError: () => {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rejections).toHaveLength(3);
    rejections[1]!(new Error('driver gave up'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(rejections).toHaveLength(4);
    await drain(scheduler);
  });

  it('allows at most 30 s for a slow plugin, whatever its interval', async () => {
    const errors: string[] = [];
    const hung = fakePlugin('hung', 600_000, () => new Promise<number | null>(() => {}));
    const scheduler = startScheduler(db, [hung], {
      onError: (_p, e) => errors.push((e as Error).message)
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(errors).toEqual(['hung: collect() did not finish within 30000 ms']);
    await drain(scheduler);
  });
});
