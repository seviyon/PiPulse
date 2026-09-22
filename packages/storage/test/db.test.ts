import { describe, expect, it } from 'vitest';
import { openDb, insertSample, getLatest, getHistory } from '../src/index.js';

describe('storage', () => {
  it('creates the schema and round-trips samples', () => {
    const db = openDb(':memory:');

    insertSample(db, { ts: 1000, metric: 'cpu_load', value: 12.5 });
    insertSample(db, { ts: 2000, metric: 'cpu_load', value: 42 });
    insertSample(db, { ts: 1500, metric: 'memory_used', value: 6100 });

    const latest = getLatest(db);
    expect(latest).toHaveLength(2);
    expect(latest.find((s) => s.metric === 'cpu_load')?.value).toBe(42);
    expect(latest.find((s) => s.metric === 'memory_used')?.value).toBe(6100);

    const history = getHistory(db, 'cpu_load', 0, 3000);
    expect(history.map((s) => s.value)).toEqual([12.5, 42]);

    db.close();
  });

  it('replaces a sample written twice at the same timestamp', () => {
    const db = openDb(':memory:');
    insertSample(db, { ts: 1000, metric: 'cpu_load', value: 10 });
    insertSample(db, { ts: 1000, metric: 'cpu_load', value: 20 });

    const history = getHistory(db, 'cpu_load', 0, 2000);
    expect(history).toHaveLength(1);
    expect(history[0]?.value).toBe(20);

    db.close();
  });
});
