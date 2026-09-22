import { describe, expect, it } from 'vitest';
import {
  builtinPlugins,
  validatePlugin,
  MAX_INTERVAL_MS,
  PLUGIN_API_VERSION,
  type CollectorPlugin
} from '../src/index.js';

const validPlugin: CollectorPlugin = {
  id: 'valid_metric',
  label: 'Valid',
  unit: 'x',
  intervalMs: 1000,
  apiVersion: 1,
  collect: async () => 1
};

describe('validatePlugin', () => {
  it('accepts a well-formed plugin', () => {
    expect(validatePlugin(validPlugin)).toEqual([]);
  });

  it('rejects an id that is not snake_case', () => {
    expect(validatePlugin({ ...validPlugin, id: 'CPU Load' })).toContain(
      'id must be lowercase snake_case'
    );
  });

  it('rejects an empty label', () => {
    expect(validatePlugin({ ...validPlugin, label: ' ' })).toContain('label must not be empty');
  });

  it('rejects a non-positive, fractional or overflowing interval', () => {
    const message = `intervalMs must be a positive integer no greater than ${MAX_INTERVAL_MS}`;
    expect(validatePlugin({ ...validPlugin, intervalMs: 0 })).toContain(message);
    expect(validatePlugin({ ...validPlugin, intervalMs: 1.5 })).toContain(message);
    expect(validatePlugin({ ...validPlugin, intervalMs: MAX_INTERVAL_MS + 1 })).toContain(message);
    expect(validatePlugin({ ...validPlugin, intervalMs: MAX_INTERVAL_MS })).toEqual([]);
  });

  it('reports missing or mistyped fields instead of throwing or accepting them', () => {
    const { id: _id, label: _label, ...rest } = validPlugin;
    expect(validatePlugin({ ...rest, unit: 5, collect: 'nope' })).toEqual([
      'id must be lowercase snake_case',
      'label must not be empty',
      'unit must be a string',
      'collect must be a function'
    ]);
    expect(validatePlugin({ ...validPlugin, intervalMs: '1000' })).toHaveLength(1);
  });

  it('rejects a non-object plugin', () => {
    expect(validatePlugin(null)).toEqual(['plugin must be an object']);
    expect(validatePlugin('cpu_load')).toEqual(['plugin must be an object']);
  });

  it('rejects a plugin built for a different API version', () => {
    const futurePlugin = { ...validPlugin, apiVersion: 2 } as unknown as CollectorPlugin;
    expect(validatePlugin(futurePlugin)).toContain(
      `apiVersion 2 is not supported (expected ${PLUGIN_API_VERSION})`
    );
  });
});

// Every plugin, built-in or third-party, must pass this suite.
describe.each(builtinPlugins.map((plugin) => [plugin.id, plugin] as const))(
  'plugin contract: %s',
  (_id, plugin) => {
    it('satisfies validatePlugin', () => {
      expect(validatePlugin(plugin)).toEqual([]);
    });

    it('collect() resolves to a finite number or null', async () => {
      const value = await plugin.collect();
      expect(value === null || Number.isFinite(value)).toBe(true);
    });
  }
);

describe('builtinPlugins', () => {
  it('have unique ids', () => {
    const ids = builtinPlugins.map((plugin) => plugin.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
