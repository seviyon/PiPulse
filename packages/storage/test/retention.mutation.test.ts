import { describe, expect, it } from 'vitest';
import { resolveRetention, validateRetention } from '../src/index.js';

const current = resolveRetention({}, {});
const twoDays = { ms: 2 * 86_400_000, ruleId: 'slow', text: '2d' };

describe('resolveRetention edges', () => {
  it('allows two neighbouring levels of the same length', () => {
    const levels = resolveRetention(
      { PIPULSE_RETENTION_RAW: '14d', PIPULSE_RETENTION_1M: '14d' },
      {}
    );
    expect(levels.raw.ms).toBe(levels['1m'].ms);
  });

  it('trims the text of an environment value', () => {
    expect(resolveRetention({ PIPULSE_RETENTION_RAW: ' 36h\n' }, {}).raw.text).toBe('36h');
  });

  it('says that a saved value which is not text was ignored for that reason', () => {
    const ignored: string[] = [];
    resolveRetention({}, { 'retention.raw': 5 }, (message) => ignored.push(message));
    expect(ignored).toEqual(['saved retention.raw ignored: it is not text']);
  });

  it('skips a bad saved value when nobody listens for the report', () => {
    expect(resolveRetention({}, { 'retention.raw': 'soon' }).raw.source).toBe('default');
  });

  it('skips saved values that are out of order when nobody listens for the report', () => {
    expect(resolveRetention({}, { 'retention.raw': '30d' }).raw.source).toBe('default');
  });

  it('names the hourly level in an order error', () => {
    expect(() => resolveRetention({ PIPULSE_RETENTION_1M: '2y' }, {})).toThrow(
      'PIPULSE_RETENTION_1M (2y) must not be longer than hourly retention (1y)'
    );
  });
});

describe('validateRetention edges', () => {
  it('names the daily level in an order error', () => {
    expect(validateRetention({ '1d': '30d' }, current)).toEqual({
      ok: false,
      errors: { '1h': 'must not be longer than daily retention (30d)' }
    });
  });

  it('reports only the unreadable fields, before checking the order', () => {
    const result = validateRetention({ raw: '30d', '1m': 'soon' }, current);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : Object.keys(result.errors)).toEqual(['1m']);
  });

  it.each(['2d', '3d'])('accepts raw retention of %s for a 2d look-back', (raw) => {
    expect(validateRetention({ raw }, current, twoDays).ok).toBe(true);
  });
});
