import { describe, expect, it } from 'vitest';
import { dbPathOf } from '../src/config.js';

describe('dbPathOf', () => {
  it('defaults and keeps absolute paths', () => {
    expect(dbPathOf({})).toBe('/var/lib/pipulse/pipulse.sqlite');
    expect(dbPathOf({ PIPULSE_DB_PATH: '/srv/p.sqlite' })).toBe('/srv/p.sqlite');
  });
  it('resolves a relative path from the service directory, not the caller', () => {
    expect(dbPathOf({ PIPULSE_DB_PATH: 'data/p.sqlite' })).toBe('/var/lib/pipulse/data/p.sqlite');
    expect(dbPathOf({ PIPULSE_DB_PATH: 'p.sqlite' }, '/data/pipulse.sqlite', '/data')).toBe(
      '/data/p.sqlite'
    );
  });
});
