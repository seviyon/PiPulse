import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinPlugins as realPlugins, validatePlugin } from '@pipulse/collector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinPlugins as fakePlugins } from '../src/harness/fake-collector.js';
import {
  ALERTS_MARKER,
  DEFAULT_READINGS,
  FAKE_INTERVAL_MS,
  READINGS_ENV,
  readReadings,
  writeReadings
} from '../src/harness/readings.js';

const realStartAlerts = vi.hoisted(() => vi.fn(() => ({ check() {}, stop() {} })));
vi.mock('@pipulse/alerts', () => ({ startAlerts: realStartAlerts, other: 'kept' }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-fakes-'));
});
afterEach(() => {
  delete process.env[READINGS_ENV];
  delete process.env['PIPULSE_E2E_ALERT_INTERVAL_MS'];
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('DEFAULT_READINGS', () => {
  it('has exactly the ids of the real built-in plugins', () => {
    // A new built-in plugin fails here until it gets a default.
    expect(Object.keys(DEFAULT_READINGS).sort()).toEqual(realPlugins.map((p) => p.id).sort());
  });
});

describe('fake plugins', () => {
  it('keep every built-in id, label, unit and api version, in order', () => {
    expect(
      fakePlugins.map(({ id, label, unit, apiVersion }) => ({ id, label, unit, apiVersion }))
    ).toEqual(
      realPlugins.map(({ id, label, unit, apiVersion }) => ({ id, label, unit, apiVersion }))
    );
  });

  it('poll every FAKE_INTERVAL_MS and satisfy the plugin contract', () => {
    for (const plugin of fakePlugins) {
      expect(plugin.intervalMs).toBe(FAKE_INTERVAL_MS);
      expect(validatePlugin(plugin), plugin.id).toEqual([]);
    }
  });

  it('collect what the readings file holds, and null for what it does not', async () => {
    const path = join(dir, 'readings.json');
    process.env[READINGS_ENV] = path;
    writeFileSync(path, JSON.stringify({ cpu_load: 55.5, throttled: null }));
    const collect = (id: string) => fakePlugins.find((p) => p.id === id)!.collect();
    expect(await collect('cpu_load')).toBe(55.5);
    expect(await collect('throttled')).toBeNull();
    expect(await collect('memory_used')).toBeNull();
    writeFileSync(path, JSON.stringify({ cpu_load: 71 }));
    expect(await collect('cpu_load')).toBe(71);
  });

  it('collect nothing when there is no readings file yet', async () => {
    process.env[READINGS_ENV] = join(dir, 'missing.json');
    expect(await fakePlugins[0]!.collect()).toBeNull();
  });
});

describe('readings file', () => {
  it('writeReadings leaves no temp file behind and never exposes a partial file', () => {
    const path = join(dir, 'readings.json');
    for (let i = 0; i < 200; i++) {
      writeReadings(path, { cpu_load: i, memory_used: i + 0.5, throttled: null });
      expect(readReadings(path)).toEqual({ cpu_load: i, memory_used: i + 0.5, throttled: null });
    }
    expect(readdirSync(dir)).toEqual(['readings.json']);
  });

  it('readReadings of a missing file is {} (no file yet)', () => {
    expect(readReadings(join(dir, 'nope.json'))).toEqual({});
  });

  it('readReadings of a corrupt file throws, naming the path, instead of turning into {}', () => {
    const path = join(dir, 'readings.json');
    writeFileSync(path, 'not json');
    expect(() => readReadings(path)).toThrow(
      new RegExp(`${READINGS_ENV} .*readings\\.json: invalid JSON`)
    );
    writeFileSync(path, '[1]');
    expect(() => readReadings(path)).toThrow(/not an object/);
    writeFileSync(path, '{"cpu_load":"high"}');
    expect(() => readReadings(path)).toThrow(/cpu_load.*number or null/);
  });
});

describe('fake startAlerts', () => {
  it('checks every second by default and keeps every other option', async () => {
    const { startAlerts } = await import('../src/harness/fake-alerts.js');
    const options = { rules: [], metrics: [], onError: () => {} };
    startAlerts({} as never, options);
    expect(realStartAlerts).toHaveBeenCalledWith({}, { ...options, intervalMs: 1000 });
  });

  it('says it started (the launcher looks for this line)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { startAlerts } = await import('../src/harness/fake-alerts.js');
      startAlerts({} as never, { rules: [], metrics: [] });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(ALERTS_MARKER));
    } finally {
      log.mockRestore();
    }
  });

  it('refuses an interval that is not a number or is tiny', async () => {
    const { startAlerts } = await import('../src/harness/fake-alerts.js');
    for (const bad of ['abc', '0', '-5', '10']) {
      process.env['PIPULSE_E2E_ALERT_INTERVAL_MS'] = bad;
      expect(() => startAlerts({} as never, { rules: [], metrics: [] }), bad).toThrow(
        /at least 50 ms/
      );
    }
  });

  it('takes the interval from PIPULSE_E2E_ALERT_INTERVAL_MS', async () => {
    process.env['PIPULSE_E2E_ALERT_INTERVAL_MS'] = '250';
    const { startAlerts } = await import('../src/harness/fake-alerts.js');
    startAlerts({} as never, { rules: [], metrics: [] });
    expect(realStartAlerts).toHaveBeenCalledWith({}, { rules: [], metrics: [], intervalMs: 250 });
  });
});
