import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSettings,
  openDb,
  policyOf,
  resolveRetention,
  retentionSource,
  saveRetention,
  saveSettings,
  validateRetention,
  type PiPulseDb
} from '../src/index.js';

const DAY = 86_400_000;
let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

describe('resolveRetention', () => {
  it('takes the environment over a saved value over the default, saying which won', () => {
    const levels = resolveRetention(
      { PIPULSE_RETENTION_1H: '2y' },
      { 'retention.raw': '7d', 'retention.1h': '30d' }
    );
    expect(levels.raw).toEqual({
      text: '7d',
      ms: 7 * DAY,
      source: 'saved',
      variable: 'PIPULSE_RETENTION_RAW'
    });
    expect(levels['1m']).toMatchObject({ text: '14d', source: 'default' });
    expect(levels['1h']).toMatchObject({ text: '2y', ms: 730 * DAY, source: 'env' });
    expect(levels['1d']).toMatchObject({ text: 'forever', ms: Infinity, source: 'default' });
  });

  it('skips a saved value that no longer parses, reporting it', () => {
    const ignored = vi.fn();
    const levels = resolveRetention({}, { 'retention.raw': '5m' }, ignored);
    expect(levels.raw.source).toBe('default');
    expect(ignored).toHaveBeenCalledWith(expect.stringMatching(/retention\.raw ignored/));
  });

  it('ignores saved values that an environment variable has made out of order', () => {
    const ignored = vi.fn();
    const levels = resolveRetention(
      { PIPULSE_RETENTION_1M: '14d' },
      { 'retention.raw': '30d' },
      ignored
    );
    expect(levels.raw).toMatchObject({ text: '2d', source: 'default' });
    expect(ignored).toHaveBeenCalledWith(expect.stringMatching(/saved retention ignored/));
  });

  it('throws when the environment alone is out of order or invalid', () => {
    expect(() => resolveRetention({ PIPULSE_RETENTION_RAW: '30d' }, {})).toThrow(
      /^PIPULSE_RETENTION_RAW \(30d\) must not be longer than 1-minute retention \(14d\)$/
    );
    expect(() => resolveRetention({ PIPULSE_RETENTION_RAW: '5m' }, {})).toThrow(
      /PIPULSE_RETENTION_RAW must be a duration/
    );
  });
});

describe('validateRetention', () => {
  const current = resolveRetention({ PIPULSE_RETENTION_1D: 'forever' }, {});

  it('accepts a valid proposal as saved levels', () => {
    const check = validateRetention({ raw: ' 7d ', '1m': '30d' }, current);
    expect(check.ok && policyOf(check.levels)).toEqual({
      raw: 7 * DAY,
      '1m': 30 * DAY,
      '1h': 365 * DAY,
      '1d': Infinity
    });
    expect(check.ok && check.levels.raw).toMatchObject({ text: '7d', source: 'saved' });
  });

  it('reports each bad field', () => {
    expect(validateRetention({ raw: '5m', '1m': '0d' }, current)).toEqual({
      ok: false,
      errors: {
        raw: expect.stringMatching(/raw retention must be a duration/),
        '1m': expect.stringMatching(/1-minute retention must be a duration/)
      }
    });
  });

  it('refuses levels out of order and a field locked by the environment', () => {
    expect(validateRetention({ raw: '30d' }, current)).toEqual({
      ok: false,
      errors: { raw: 'must not be longer than 1-minute retention (14d)' }
    });
    expect(validateRetention({ '1d': '10y' }, current)).toEqual({
      ok: false,
      errors: { '1d': 'set by PIPULSE_RETENTION_1D; change it there' }
    });
    // Sending the locked value back unchanged is fine (the page sends every field).
    expect(validateRetention({ '1d': 'forever' }, current).ok).toBe(true);
  });

  it('keeps raw retention at least as long as the longest alert look-back', () => {
    expect(
      validateRetention({ raw: '10min' }, current, {
        ms: 15 * 60_000,
        ruleId: 'load_queueing',
        text: '15min'
      })
    ).toEqual({
      ok: false,
      errors: { raw: 'must be at least 15min: rule "load_queueing" looks back 15min' }
    });
  });
});

describe('saveRetention and retentionSource', () => {
  it('saves only the levels the operator changed, and the source sees them at once', () => {
    const env = { PIPULSE_RETENTION_1D: '5y' };
    const getRetention = retentionSource(db, env);
    const check = validateRetention(
      { raw: '7d', '1m': '14d', '1h': '1y', '1d': '5y' },
      getRetention()
    );
    if (!check.ok) throw new Error('expected a valid proposal');
    saveRetention(db, check.levels);
    expect(getSettings(db)).toEqual({ 'retention.raw': '7d' });
    expect(getRetention().raw).toMatchObject({ ms: 7 * DAY, source: 'saved' });
  });

  it('logs an ignored saved value once, not on every read', () => {
    saveSettings(db, { 'retention.raw': 'soon' });
    const log = vi.fn();
    const getRetention = retentionSource(db, {}, log);
    getRetention();
    getRetention();
    expect(log).toHaveBeenCalledOnce();
  });
});
