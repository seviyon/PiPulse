import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION,
  estimateBytes,
  insertSample,
  openDb,
  previewDeletion,
  storageUsage,
  type PiPulseDb
} from '../src/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 20);
let db: PiPulseDb;

beforeEach(() => {
  db = openDb(':memory:');
  for (let ts = NOW - 3 * DAY; ts <= NOW; ts += HOUR) {
    insertSample(db, { ts, metric: 'cpu_load', value: 1 });
  }
  db.prepare(
    "INSERT INTO metrics_rollup (ts, metric, resolution, avg, min, max) VALUES (?, 'cpu_load', '1h', 1, 1, 1)"
  ).run(NOW - 10 * DAY);
});
afterEach(() => db.close());

describe('storageUsage', () => {
  it('counts rows and the oldest row per level', () => {
    const usage = storageUsage(db);
    expect(usage.levels.raw).toEqual({ rows: 73, oldest: NOW - 3 * DAY });
    expect(usage.levels['1h']).toEqual({ rows: 1, oldest: NOW - 10 * DAY });
    expect(usage.levels['1m']).toEqual({ rows: 0, oldest: null });
    expect(usage.fileBytes).toBeGreaterThan(0);
  });
});

describe('previewDeletion', () => {
  it('counts only what the change itself removes, and the span it covers', () => {
    const preview = previewDeletion(
      db,
      { ...DEFAULT_RETENTION, raw: DAY, '1h': 7 * DAY },
      DEFAULT_RETENTION,
      NOW
    );
    // Raw rows older than 2 days were due anyway: only [NOW - 2d, NOW - 1d) is the change's doing.
    expect(preview.raw).toEqual({ deletesRows: 24, from: NOW - 2 * DAY, to: NOW - DAY });
    expect(preview['1h']).toEqual({ deletesRows: 1, from: NOW - 10 * DAY, to: NOW - 7 * DAY });
    expect(preview['1d']).toEqual({ deletesRows: 0, from: null, to: null });
  });

  it('counts nothing for unchanged or longer levels, even with overdue rows', () => {
    // Raw rows past the current 2-day cutoff exist (housekeeping runs once a minute).
    const preview = previewDeletion(
      db,
      { ...DEFAULT_RETENTION, '1h': 2 * 365 * DAY },
      DEFAULT_RETENTION,
      NOW
    );
    expect(preview.raw.deletesRows).toBe(0);
    expect(preview['1h'].deletesRows).toBe(0);
  });
});

describe('estimateBytes', () => {
  it('scales rows per day by retention, keeping forever for a year', () => {
    const usage = {
      fileBytes: 50_000_000,
      freeBytes: 0,
      levels: {
        raw: { rows: 500_000, oldest: 0 },
        '1m': { rows: 300_000, oldest: 0 },
        '1h': { rows: 150_000, oldest: 0 },
        '1d': { rows: 50_000, oldest: 0 }
      }
    };
    // One metric every 10 s: raw 8640/day, 1m 1440, 1h 24, 1d 1; 50 bytes a row.
    const bytes = estimateBytes(
      { raw: 2 * DAY, '1m': 14 * DAY, '1h': 365 * DAY, '1d': Infinity },
      [{ intervalMs: 10_000 }],
      usage
    );
    expect(bytes).toBe((8640 * 2 + 1440 * 14 + 24 * 365 + 365) * 50);
  });

  it('assumes 50 bytes a row while the database is nearly empty', () => {
    const empty = {
      fileBytes: 4096,
      freeBytes: 0,
      levels: storageUsage(openDb(':memory:')).levels
    };
    expect(
      estimateBytes(
        { raw: DAY, '1m': DAY, '1h': DAY, '1d': DAY },
        [{ intervalMs: 86_400_000 }],
        empty
      )
    ).toBe((1 + 1440 + 24 + 1) * 50); // raw, 1m, 1h, 1d rows for one day of one metric
  });
});
