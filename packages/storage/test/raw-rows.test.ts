import { describe, expect, it } from 'vitest';
import { insertSample, MAX_RAW_ROWS, openDb, rawRowsExceed } from '../src/index.js';

function filled(count: number, metric = 'cpu_load') {
  const db = openDb(':memory:');
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) insertSample(db, { ts: 1_000 + i, metric, value: i });
  db.exec('COMMIT');
  return db;
}

describe('rawRowsExceed', () => {
  it('allows 5000 raw readings by default', () => {
    expect(MAX_RAW_ROWS).toBe(5000);
  });

  it('is false up to the limit and true one reading past it', () => {
    const db = filled(MAX_RAW_ROWS + 1);
    const last = 1_000 + MAX_RAW_ROWS;
    expect(rawRowsExceed(db, 'cpu_load', 1_000, last - 1)).toBe(false);
    expect(rawRowsExceed(db, 'cpu_load', 1_000, last)).toBe(true);
    expect(rawRowsExceed(db, 'cpu_load', 1_001, last)).toBe(false);
  });

  it('takes the limit as a parameter and counts both ends of the window', () => {
    const db = filled(10);
    expect(rawRowsExceed(db, 'cpu_load', 1_000, 1_009, 10)).toBe(false);
    expect(rawRowsExceed(db, 'cpu_load', 1_000, 1_009, 9)).toBe(true);
    expect(rawRowsExceed(db, 'cpu_load', 1_000, 1_000, 0)).toBe(true);
  });

  it('counts only the named metric, and an empty window or metric is not over', () => {
    const db = filled(10);
    insertSample(db, { ts: 1_005, metric: 'other', value: 1 });
    expect(rawRowsExceed(db, 'other', 0, 2_000, 1)).toBe(false);
    expect(rawRowsExceed(db, 'missing', 0, 2_000, 0)).toBe(false);
    expect(rawRowsExceed(db, 'cpu_load', 5_000, 6_000, 0)).toBe(false);
  });
});
