import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('reads a retention function on every run, so a change applies without a restart', () => {
    const now = Date.now();
    insertSample(db, { ts: now - 3 * 3_600_000, metric: 'cpu_load', value: 1 });
    let policy = { raw: 7 * 86_400_000, '1m': 14 * 86_400_000, '1h': Infinity, '1d': Infinity };
    const housekeeping = startHousekeeping(db, {
      intervalMs: 60_000,
      retention: () => policy,
      vacuum: false
    });
    const raw = () => (db.prepare('SELECT COUNT(*) AS n FROM metrics').get() as { n: number }).n;
    expect(raw()).toBe(1);
    policy = { ...policy, raw: 3_600_000 };
    vi.advanceTimersByTime(60_000);
    expect(raw()).toBe(0);
    housekeeping.stop();
  });

  it('vacuums a fragmented file database once, then waits a day', () => {
    const file = openDb(join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'db.sqlite'));
    file.exec('BEGIN');
    for (let ts = 0; ts < 20_000; ts++) insertSample(file, { ts, metric: 'x', value: ts });
    file.exec('COMMIT');
    file.exec('DELETE FROM metrics WHERE ts < 18000');
    const onVacuum = vi.fn();
    const housekeeping = startHousekeeping(file, {
      intervalMs: 60_000,
      vacuum: { minFileBytes: 0, diskFree: () => 10 ** 12, onVacuum }
    });
    expect(onVacuum).toHaveBeenCalledWith(expect.objectContaining({ ran: true }));
    file.exec('DELETE FROM metrics');
    vi.advanceTimersByTime(60_000);
    expect(onVacuum).toHaveBeenCalledOnce();
    housekeeping.stop();
    file.close();
  });
});
