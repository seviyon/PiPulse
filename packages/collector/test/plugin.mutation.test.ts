import { describe, expect, it } from 'vitest';
import { validatePlugin, type CollectorPlugin } from '../src/index.js';

const validPlugin: CollectorPlugin = {
  id: 'valid_metric',
  label: 'Valid',
  unit: 'x',
  intervalMs: 1000,
  apiVersion: 1,
  collect: async () => 1
};

describe('validatePlugin ids', () => {
  it.each(['cpu-load', 'cpu load', 'cpu.load', 'cpu_load!', 'cpu_load\n'])(
    'rejects %j: the whole id must be snake_case, not just its start',
    (id) => {
      expect(validatePlugin({ ...validPlugin, id })).toContain('id must be lowercase snake_case');
    }
  );

  it('accepts digits and underscores after the first letter', () => {
    expect(validatePlugin({ ...validPlugin, id: 'load_1' })).toEqual([]);
  });
});
