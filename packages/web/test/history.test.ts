import { describe, expect, it } from 'vitest';
import { chartGroups, resolutionLabel, summarize, toChartData } from '../src/history.js';
import { parseRoute, routeHash } from '../src/router.js';
import type { PluginInfo, SeriesPoint } from '../src/types.js';

const plugin = (id: string, label: string, unit = '%'): PluginInfo => ({
  id,
  label,
  unit,
  intervalMs: 5000
});

const point = (ts: number, avg: number, min = avg, max = avg): SeriesPoint => ({
  ts,
  avg,
  min,
  max
});

describe('chartGroups', () => {
  it('gives each metric its own chart, pairs network directions, and skips flags', () => {
    const groups = chartGroups([
      plugin('cpu_load', 'CPU load'),
      plugin('throttled', 'Throttling', 'flags'),
      plugin('network_rx', 'Network received', 'B/s'),
      plugin('network_tx', 'Network sent', 'B/s')
    ]);

    expect(groups).toEqual([
      {
        id: 'cpu_load',
        label: 'CPU load',
        unit: '%',
        metrics: [{ id: 'cpu_load', label: 'CPU load' }]
      },
      {
        id: 'network',
        label: 'Network',
        unit: 'B/s',
        metrics: [
          { id: 'network_rx', label: 'Received' },
          { id: 'network_tx', label: 'Sent' }
        ]
      }
    ]);
  });

  it('keeps a network direction on its own when its partner is missing', () => {
    expect(chartGroups([plugin('network_rx', 'Network received', 'B/s')])).toEqual([
      {
        id: 'network_rx',
        label: 'Network received',
        unit: 'B/s',
        metrics: [{ id: 'network_rx', label: 'Network received' }]
      }
    ]);
  });
});

describe('toChartData', () => {
  it('builds x (seconds), avg, min and max columns for a single series', () => {
    const data = toChartData([[point(60_000, 2, 1, 3), point(120_000, 4, 2, 6)]]);
    expect(data).toEqual([
      [60, 120],
      [2, 4],
      [1, 2],
      [3, 6]
    ]);
  });

  it('aligns several series on shared seconds, even when raw timestamps differ by milliseconds', () => {
    const data = toChartData([
      [point(5_000_010, 1), point(5_005_012, 2)],
      [point(5_000_450, 7), point(5_005_470, 8)]
    ]);
    expect(data).toEqual([
      [5000, 5005],
      [1, 2],
      [7, 8]
    ]);
  });

  it('draws paired series through readings that fall in different seconds', () => {
    // rx just before each whole second, tx just after: a millisecond apart,
    // but always in different seconds, as when the two timers have drifted.
    const rx = [0, 1, 2, 3].map((i) => point(4_999 + i * 5_000, i));
    const tx = [0, 1, 2, 3].map((i) => point(5_001 + i * 5_000, 10 + i));
    const data = toChartData([rx, tx]);
    expect(data).toEqual([
      [4, 5, 9, 10, 14, 15, 19, 20],
      [0, undefined, 1, undefined, 2, undefined, 3, undefined],
      [undefined, 10, undefined, 11, undefined, 12, undefined, 13]
    ]);
    // uPlot breaks lines only at null, so nothing here splits a line.
    expect(data.flat()).not.toContain(null);
  });

  it('breaks only the series that stopped, not its pair', () => {
    const rx = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => point(i * 5_000, i));
    const tx = [0, 1, 2, 6, 7].map((i) => point(i * 5_000, 10 + i));
    const [x, rxColumn, txColumn] = toChartData([rx, tx]);
    expect(x).toEqual([0, 5, 10, 15, 20, 25, 30, 35]);
    expect(rxColumn).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(txColumn).toEqual([10, 11, 12, null, undefined, undefined, 16, 17]);
  });

  it('breaks the line where collection stopped instead of bridging the outage', () => {
    const minutes = [0, 1, 2, 30, 31].map((m) => point(m * 60_000, m));
    const [x, avg] = toChartData([minutes]);
    expect(x).toEqual([0, 60, 120, 180, 1800, 1860]);
    expect(avg).toEqual([0, 1, 2, null, 30, 31]);
  });

  it('returns empty columns for no data', () => {
    expect(toChartData([[]])).toEqual([[], [], [], []]);
  });
});

describe('summarize', () => {
  it('reports the lowest low, mean average and highest high', () => {
    expect(summarize([point(0, 2, 1, 5), point(1, 4, 3, 9)])).toEqual({
      low: 1,
      average: 3,
      high: 9
    });
  });

  it('returns undefined without data', () => {
    expect(summarize([])).toBeUndefined();
  });
});

describe('resolutionLabel', () => {
  it.each([
    ['raw', 'Every reading'],
    ['1m', '1-minute averages'],
    ['1h', 'Hourly averages'],
    ['1d', 'Daily averages']
  ] as const)('%s → %s', (resolution, label) => {
    expect(resolutionLabel(resolution)).toBe(label);
  });
});

describe('router', () => {
  it.each([
    ['', { page: 'now' }],
    ['#/', { page: 'now' }],
    ['#/history', { page: 'history', range: '24h' }],
    ['#/history?range=7d', { page: 'history', range: '7d' }],
    ['#/history?range=bogus', { page: 'history', range: '24h' }],
    ['#/nowhere', { page: 'now' }]
  ])('parses %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it('round-trips a history route', () => {
    expect(parseRoute(routeHash({ page: 'history', range: '30d' }))).toEqual({
      page: 'history',
      range: '30d'
    });
    expect(routeHash({ page: 'now' })).toBe('#/');
  });
});
