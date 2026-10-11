import { describe, expect, it } from 'vitest';
import { applyHistory, applySample, applySnapshot, emptyState, isStale } from '../src/store.js';

const WINDOW = 15 * 60 * 1000;

describe('live store', () => {
  it('seeds a series from history and takes its last point as latest', () => {
    const state = applyHistory(emptyState(), 'cpu_load', [
      { ts: 1000, metric: 'cpu_load', value: 1 },
      { ts: 2000, metric: 'cpu_load', value: 2 }
    ]);
    expect(state.series['cpu_load']?.map((s) => s.value)).toEqual([1, 2]);
    expect(state.latest['cpu_load']?.value).toBe(2);
  });

  it('keeps live samples that arrived while the history request was in flight', () => {
    let state = applySample(emptyState(), { ts: 3000, metric: 'm', value: 3 }, WINDOW);
    state = applyHistory(state, 'm', [
      { ts: 1000, metric: 'm', value: 1 },
      { ts: 2000, metric: 'm', value: 2 }
    ]);
    expect(state.series['m']?.map((s) => s.ts)).toEqual([1000, 2000, 3000]);
    expect(state.latest['m']?.ts).toBe(3000);
  });

  it('takes the snapshot as latest without touching series', () => {
    const state = applySnapshot(emptyState(), [{ ts: 5, metric: 'disk_used', value: 57 }]);
    expect(state.latest['disk_used']?.value).toBe(57);
    expect(state.series['disk_used']).toBeUndefined();
  });

  it('appends a new sample and trims points older than the window', () => {
    let state = applyHistory(emptyState(), 'cpu_load', [
      { ts: 0, metric: 'cpu_load', value: 1 },
      { ts: WINDOW, metric: 'cpu_load', value: 2 }
    ]);
    state = applySample(state, { ts: WINDOW + 5000, metric: 'cpu_load', value: 3 }, WINDOW);
    expect(state.series['cpu_load']?.map((s) => s.ts)).toEqual([WINDOW, WINDOW + 5000]);
    expect(state.latest['cpu_load']?.value).toBe(3);
  });

  it('ignores a sample it already has, e.g. one repeated after a reconnect', () => {
    let state = applyHistory(emptyState(), 'm', [{ ts: 10, metric: 'm', value: 1 }]);
    state = applySample(state, { ts: 10, metric: 'm', value: 1 }, WINDOW);
    state = applySample(state, { ts: 9, metric: 'm', value: 0 }, WINDOW);
    expect(state.series['m']?.map((s) => s.ts)).toEqual([10]);
    expect(state.latest['m']?.ts).toBe(10);
  });

  it('never lets an older snapshot overwrite a newer latest value', () => {
    let state = applySample(emptyState(), { ts: 20, metric: 'm', value: 2 }, WINDOW);
    state = applySnapshot(state, [{ ts: 10, metric: 'm', value: 1 }]);
    expect(state.latest['m']?.value).toBe(2);
  });
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('a clock that steps back', () => {
  const at = (ts: number, value = 1) => ({ ts, metric: 'm', value });

  it('starts the series over from a live sample far older than the last one', () => {
    let state = applySample(emptyState(), at(30 * DAY), WINDOW);
    state = applySample(state, at(30 * DAY + 5000), WINDOW);
    state = applySample(state, at(1000, 9), WINDOW); // the Pi's clock was corrected: 30 days back
    expect(state.series['m']?.map((s) => s.ts)).toEqual([1000]);
    expect(state.latest['m']?.value).toBe(9);
    state = applySample(state, at(6000, 10), WINDOW); // and it goes on from there
    expect(state.series['m']?.map((s) => s.ts)).toEqual([1000, 6000]);
    expect(state.latest['m']?.value).toBe(10);
  });

  it('still drops a duplicate and a slightly late sample', () => {
    let state = applySample(emptyState(), at(100 * MIN), WINDOW);
    state = applySample(state, at(100 * MIN), WINDOW);
    state = applySample(state, at(100 * MIN - 20_000, 5), WINDOW);
    state = applySample(state, at(100 * MIN - 4 * MIN, 5), WINDOW); // 4 minutes: not a clock step
    expect(state.series['m']).toHaveLength(1);
  });

  it('takes a snapshot from far in the past as the latest value, a slightly older one not', () => {
    let state = applySnapshot(emptyState(), [at(30 * DAY, 1)]);
    state = applySnapshot(state, [at(30 * DAY - MIN, 2)]);
    expect(state.latest['m']?.value).toBe(1);
    state = applySnapshot(state, [at(1000, 3)]);
    expect(state.latest['m']?.value).toBe(3);
  });

  it('drops live points that history shows are from the clock that read ahead', () => {
    let state = applySample(emptyState(), at(30 * DAY), WINDOW);
    state = applyHistory(state, 'm', [at(1000), at(2000)]);
    expect(state.series['m']?.map((s) => s.ts)).toEqual([1000, 2000]);
    expect(state.latest['m']?.ts).toBe(2000);
  });

  it('keeps a live sample a few seconds past the history, as before', () => {
    let state = applySample(emptyState(), at(10_000), WINDOW);
    state = applyHistory(state, 'm', [at(1000), at(2000)]);
    expect(state.series['m']?.map((s) => s.ts)).toEqual([1000, 2000, 10_000]);
  });
});

describe('isStale', () => {
  it('flags a value once three poll intervals pass without an update', () => {
    const sample = { ts: 0, metric: 'cpu_load', value: 1 };
    expect(isStale(sample, 5000, 14_999)).toBe(false);
    expect(isStale(sample, 5000, 15_001)).toBe(true);
  });
});
