import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  insertSample,
  MAX_SERIES_ROWS,
  openDb,
  seriesRowsExceed,
  type PiPulseDb
} from '../src/index.js';

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
  const insert = db.prepare(
    'INSERT INTO metrics_rollup (ts, metric, resolution, avg, min, max) VALUES (?, ?, ?, 1, 1, 1)'
  );
  for (let ts = 1; ts <= 5; ts++) insert.run(ts, 'a', '1h');
  insert.run(6, 'a', '1d');
  insert.run(1, 'b', '1h');
  insertSample(db, { ts: 1, metric: 'a', value: 1 });
  insertSample(db, { ts: 2, metric: 'a', value: 1 });
});
afterEach(() => db.close());

describe('seriesRowsExceed', () => {
  it('is 10000 rows by default for a request', () => {
    expect(MAX_SERIES_ROWS).toBe(10_000);
  });

  it('says no at exactly the limit and yes one row over', () => {
    expect(seriesRowsExceed(db, 'a', 0, 100, '1h', 5)).toBe(false);
    expect(seriesRowsExceed(db, 'a', 0, 100, '1h', 4)).toBe(true);
  });

  it('counts only the asked metric, resolution and window', () => {
    expect(seriesRowsExceed(db, 'a', 0, 100, '1d', 0)).toBe(true);
    expect(seriesRowsExceed(db, 'a', 0, 100, '1d', 1)).toBe(false);
    expect(seriesRowsExceed(db, 'b', 0, 100, '1h', 1)).toBe(false);
    expect(seriesRowsExceed(db, 'a', 2, 4, '1h', 2)).toBe(true);
    expect(seriesRowsExceed(db, 'a', 2, 4, '1h', 3)).toBe(false);
    expect(seriesRowsExceed(db, 'a', 7, 100, '1h', 0)).toBe(false);
  });

  it('counts raw readings when asked for raw', () => {
    expect(seriesRowsExceed(db, 'a', 0, 100, 'raw', 2)).toBe(false);
    expect(seriesRowsExceed(db, 'a', 0, 100, 'raw', 1)).toBe(true);
  });
});
