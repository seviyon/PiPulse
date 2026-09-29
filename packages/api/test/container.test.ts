import { describe, expect, it } from 'vitest';
import { openDb } from '@pipulse/storage';
import { buildServer } from '../src/index.js';
import { CONTAINER_UNAVAILABLE, splitForContainer } from '../src/container.js';

const plugins = [{ id: 'cpu_load' }, { id: 'cpu_voltage' }, { id: 'throttled' }];

describe('splitForContainer', () => {
  it('runs everything natively', () => {
    expect(splitForContainer(plugins, false)).toEqual({ run: plugins, unavailable: new Set() });
  });

  it('holds back the firmware plugins in a container', () => {
    const { run, unavailable } = splitForContainer(plugins, true);
    expect(run.map((p) => p.id)).toEqual(['cpu_load']);
    expect([...unavailable]).toEqual(['cpu_voltage', 'throttled']);
  });
});

describe('/api/config plugins', () => {
  it('passes the unavailable reason through', async () => {
    const db = openDb(':memory:');
    const app = buildServer(db, {
      plugins: [
        { id: 'cpu_load', label: 'CPU', unit: '%', intervalMs: 5000 },
        {
          id: 'throttled',
          label: 'Throttling',
          unit: 'flags',
          intervalMs: 60000,
          unavailable: CONTAINER_UNAVAILABLE
        }
      ]
    });
    const { plugins: served } = (await app.inject('/api/config')).json();
    expect(served[1].unavailable).toBe('Not available in Docker');
    expect(served[0].unavailable).toBeUndefined();
    await app.close();
    db.close();
  });
});
