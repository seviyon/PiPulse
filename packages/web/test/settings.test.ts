import { describe, expect, it } from 'vitest';
import {
  changed,
  checkDuration,
  describeChange,
  formatBytes,
  type SettingsBody
} from '../src/settings.js';
import { parseRoute, routeHash } from '../src/router.js';

const level = (text: string, ms: number | null) => ({
  text,
  ms,
  source: 'default' as const,
  variable: 'PIPULSE_RETENTION_RAW',
  locked: false
});
const body: SettingsBody = {
  retention: {
    raw: level('2d', 172_800_000),
    '1m': level('14d', 1_209_600_000),
    '1h': level('1y', 31_536_000_000),
    '1d': level('forever', null)
  },
  storage: {
    fileBytes: 0,
    freeBytes: 0,
    diskFreeBytes: null,
    levels: {
      raw: { rows: 0, oldest: null },
      '1m': { rows: 0, oldest: null },
      '1h': { rows: 0, oldest: null },
      '1d': { rows: 0, oldest: null }
    }
  }
};

describe('checkDuration', () => {
  it('accepts the server grammar and explains anything else', () => {
    for (const ok of ['30s', '5min', '36h', '14d', '2w', '1y', 'forever', ' 7D ']) {
      expect(checkDuration(ok)).toBeUndefined();
    }
    expect(checkDuration('5m')).toMatch(/like 30s, 5min/);
    expect(checkDuration('0d')).toMatch(/like/);
  });
});

describe('changed and describeChange', () => {
  it('lists only edited levels, ignoring spacing', () => {
    expect(changed(body, { raw: ' 2d', '1m': '30d', '1h': '1y', '1d': 'forever' })).toEqual(['1m']);
  });

  it('words a deletion and a lengthening', () => {
    expect(
      describeChange(
        'raw',
        {
          deletesRows: 41_000,
          from: Date.UTC(2026, 8, 21, 18),
          to: Date.UTC(2026, 8, 22, 18)
        },
        body.retention.raw,
        '1d'
      )
    ).toEqual({
      deletes: true,
      text: expect.stringMatching(/^Deletes ~41,000 raw readings from .+ to .+ within a minute$/)
    });
    expect(
      describeChange('raw', { deletesRows: 0, from: null, to: null }, body.retention.raw, '7d')
    ).toEqual({
      deletes: false,
      text: "Keeps more from now on. Already-deleted data doesn't come back."
    });
  });
});

describe('describeChange direction', () => {
  it('says a shorter retention keeps less even when nothing is old enough to delete yet', () => {
    expect(
      describeChange('raw', { deletesRows: 0, from: null, to: null }, body.retention.raw, '30min')
    ).toEqual({
      deletes: false,
      text: 'Keeps less from now on. Nothing is old enough to delete yet.'
    });
  });
});

describe('formatBytes and the route', () => {
  it('formats sizes and routes #/settings', () => {
    expect(formatBytes(240_000_000)).toBe('240 MB');
    expect(parseRoute('#/settings')).toEqual({ page: 'settings' });
    expect(routeHash({ page: 'settings' })).toBe('#/settings');
  });
});
