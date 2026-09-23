import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileUsage, insertSample, maybeVacuum, openDb, type PiPulseDb } from '../src/index.js';

const DAY = 86_400_000;
let db: PiPulseDb;

/** A file database with most of its pages free. */
function fragmented(): PiPulseDb {
  const file = openDb(join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'db.sqlite'));
  file.exec('BEGIN');
  for (let ts = 0; ts < 20_000; ts++) insertSample(file, { ts, metric: 'cpu_load', value: ts });
  file.exec('COMMIT');
  file.exec('DELETE FROM metrics WHERE ts < 18000');
  return file;
}

beforeEach(() => {
  db = fragmented();
});
afterEach(() => db.close());

const plenty = () => 10 ** 12;

describe('maybeVacuum', () => {
  it('compacts when free pages pass the threshold, reporting sizes', () => {
    const before = fileUsage(db);
    expect(before.freeBytes / before.fileBytes).toBeGreaterThan(0.25);
    const result = maybeVacuum(db, DAY, undefined, { minFileBytes: 0, diskFree: plenty });
    expect(result).toMatchObject({ ran: true, beforeBytes: before.fileBytes });
    expect(result?.ran && result.afterBytes).toBeLessThan(before.fileBytes);
    expect(fileUsage(db).freeBytes).toBe(0);
  });

  it('does nothing below the size or free-page thresholds', () => {
    expect(maybeVacuum(db, DAY, undefined, { diskFree: plenty })).toBeUndefined(); // < 8 MB
    expect(
      maybeVacuum(db, DAY, undefined, { minFileBytes: 0, minFreeFraction: 0.99, diskFree: plenty })
    ).toBeUndefined();
  });

  it('skips with a reason when the disk lacks room for the copy', () => {
    const result = maybeVacuum(db, DAY, undefined, { minFileBytes: 0, diskFree: () => 1000 });
    expect(result).toEqual({ ran: false, reason: expect.stringMatching(/not enough free disk/) });
  });

  it('waits a day after the last attempt', () => {
    const options = { minFileBytes: 0, diskFree: plenty };
    expect(maybeVacuum(db, DAY, 1, options)).toBeUndefined();
    expect(maybeVacuum(db, DAY + 1, 1, options)).toMatchObject({ ran: true });
  });

  it('never runs on an in-memory database', () => {
    const memory = openDb(':memory:');
    expect(
      maybeVacuum(memory, DAY, undefined, { minFileBytes: 0, diskFree: plenty })
    ).toBeUndefined();
    memory.close();
  });
});
