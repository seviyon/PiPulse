import { describe, expect, it, vi } from 'vitest';
import { openDb, getLatest } from '@pipulse/storage';
import { runOnce, cpuLoadPlugin, type CollectorPlugin } from '../src/index.js';

describe('runOnce', () => {
  it('writes a sample for every plugin that resolves a finite number', async () => {
    const db = openDb(':memory:');
    const fakePlugin: CollectorPlugin = {
      id: 'fake_metric',
      label: 'Fake',
      unit: 'x',
      intervalMs: 1000,
      apiVersion: 1,
      collect: async () => 7
    };

    await runOnce(db, [fakePlugin]);

    const latest = getLatest(db);
    expect(latest).toHaveLength(1);
    expect(latest[0]?.metric).toBe('fake_metric');
    expect(latest[0]?.value).toBe(7);

    db.close();
  });

  it('skips a plugin that returns null without throwing', async () => {
    const db = openDb(':memory:');
    const nullPlugin: CollectorPlugin = {
      id: 'unavailable_metric',
      label: 'Unavailable',
      unit: 'x',
      intervalMs: 1000,
      apiVersion: 1,
      collect: async () => null
    };

    await runOnce(db, [nullPlugin]);
    expect(getLatest(db)).toHaveLength(0);
    db.close();
  });

  it('reports a failing plugin via onError instead of throwing', async () => {
    const db = openDb(':memory:');
    const boomPlugin: CollectorPlugin = {
      id: 'boom',
      label: 'Boom',
      unit: 'x',
      intervalMs: 1000,
      apiVersion: 1,
      collect: async () => {
        throw new Error('sensor unavailable');
      }
    };
    const onError = vi.fn();

    await expect(runOnce(db, [boomPlugin], onError)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(getLatest(db)).toHaveLength(0);

    db.close();
  });

  it('cpuLoadPlugin reports a real, finite CPU load percentage', async () => {
    const value = await cpuLoadPlugin.collect();
    expect(typeof value).toBe('number');
    expect(Number.isFinite(value)).toBe(true);
  });
});
