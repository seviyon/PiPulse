import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertSample, openDb, startHousekeeping, type PiPulseDb } from '../src/index.js';

let db: PiPulseDb;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 8, 1) });
  db = openDb(':memory:');
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

const minuteRollups = () =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM metrics_rollup WHERE resolution = '1m'").get() as {
      n: number;
    }
  ).n;

describe('startHousekeeping', () => {
  it('runs at start and then every interval', () => {
    const onResult = vi.fn();
    const housekeeping = startHousekeeping(db, { intervalMs: 60_000, onResult });
    expect(onResult).toHaveBeenCalledTimes(1);

    insertSample(db, { ts: Date.now(), metric: 'cpu_load', value: 1 });
    vi.advanceTimersByTime(60_000);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(minuteRollups()).toBe(1);

    housekeeping.stop();
    vi.advanceTimersByTime(600_000);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it('reports a failed run and keeps going', () => {
    const onError = vi.fn();
    const housekeeping = startHousekeeping(db, { intervalMs: 60_000, onError });
    db.exec('DROP TABLE metrics_rollup');
    vi.advanceTimersByTime(60_000);
    expect(onError).toHaveBeenCalledOnce();

    db.exec('CREATE TABLE metrics_rollup (ts, metric, resolution, avg, min, max, count)');
    vi.advanceTimersByTime(60_000);
    expect(onError).toHaveBeenCalledOnce();
    housekeeping.stop();
  });
});
