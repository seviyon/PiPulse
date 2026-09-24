import type { PluginInfo, Resolution, SeriesPoint } from './types.js';

export interface ChartGroup {
  id: string;
  label: string;
  unit: string;
  metrics: { id: string; label: string }[];
}

/**
 * Metrics charted on the History page but kept off the live dashboard: the
 * load average is a trend signal (is work queueing?), and swap traffic
 * explains a swap-use chart rather than being a reading to watch.
 */
export const historyOnly: ReadonlySet<string> = new Set(['load_1', 'swap_io']);

/** Metrics drawn together in one chart (same unit, read side by side). */
const pairs = [
  {
    id: 'network',
    label: 'Network',
    metrics: [
      { id: 'network_rx', label: 'Received' },
      { id: 'network_tx', label: 'Sent' }
    ]
  }
];

/**
 * One chart per metric, except known pairs that share a chart. Flag
 * metrics (the throttle bitmask) have no magnitude to plot and are skipped.
 */
export function chartGroups(plugins: PluginInfo[]): ChartGroup[] {
  const groups: ChartGroup[] = [];
  const done = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.unit === 'flags' || done.has(plugin.id)) continue;
    const pair = pairs.find(
      (candidate) =>
        candidate.metrics.some((metric) => metric.id === plugin.id) &&
        candidate.metrics.every((metric) => plugins.some((p) => p.id === metric.id))
    );
    if (pair) {
      pair.metrics.forEach((metric) => done.add(metric.id));
      groups.push({ id: pair.id, label: pair.label, unit: plugin.unit, metrics: pair.metrics });
    } else {
      done.add(plugin.id);
      groups.push({
        id: plugin.id,
        label: plugin.label,
        unit: plugin.unit,
        metrics: [{ id: plugin.id, label: plugin.label }]
      });
    }
  }
  return groups;
}

/** A gap wider than this many typical steps means collection stopped. */
const GAP_STEPS = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Converts series into uPlot's column format: x in whole seconds, then one
 * avg column per series; a single series also gets min and max columns for
 * its band. Series are aligned on shared seconds, since raw readings of
 * paired metrics land a few milliseconds apart; a series with no point at
 * another's second gets `undefined` there, which uPlot draws straight
 * through (paired plugins run on separate timers, so their readings can
 * fall in different seconds). Where a series' own points are much further
 * apart than usual, it gets a `null` just after the last point before the
 * gap, which uPlot does break the line at, so an outage isn't bridged.
 * Gaps are found per series: interleaved seconds would make a shared step
 * look tiny and every ordinary interval look like an outage.
 */
export function toChartData(series: SeriesPoint[][]): (number | null | undefined)[][] {
  const byMetric = series.map(
    (points) => new Map(points.map((p) => [Math.floor(p.ts / 1000), p] as const))
  );
  const gapsByMetric = byMetric.map((map) => {
    const seconds = [...map.keys()].sort((a, b) => a - b);
    const step = median(seconds.slice(1).map((second, i) => second - seconds[i]!));
    const gaps = new Set<number>();
    for (const [i, second] of seconds.entries()) {
      const previous = seconds[i - 1];
      if (previous !== undefined && step > 0 && second - previous > step * GAP_STEPS) {
        gaps.add(previous + step);
      }
    }
    return gaps;
  });
  const x = [
    ...new Set([
      ...byMetric.flatMap((map) => [...map.keys()]),
      ...gapsByMetric.flatMap((g) => [...g])
    ])
  ].sort((a, b) => a - b);

  const column = (metric: number, pick: (p: SeriesPoint) => number) =>
    x.map((second) => {
      const found = byMetric[metric]!.get(second);
      if (found) return pick(found);
      return gapsByMetric[metric]!.has(second) ? null : undefined;
    });

  if (byMetric.length === 1) {
    return [x, column(0, (p) => p.avg), column(0, (p) => p.min), column(0, (p) => p.max)];
  }
  return [x, ...byMetric.map((_, metric) => column(metric, (p) => p.avg))];
}

export interface Summary {
  low: number;
  average: number;
  high: number;
}

/** Lowest low, mean of the averages, and highest high over the points shown. */
export function summarize(points: SeriesPoint[]): Summary | undefined {
  if (points.length === 0) return undefined;
  return {
    low: Math.min(...points.map((p) => p.min)),
    average: points.reduce((sum, p) => sum + p.avg, 0) / points.length,
    high: Math.max(...points.map((p) => p.max))
  };
}

export function resolutionLabel(resolution: Resolution): string {
  return {
    raw: 'Every reading',
    '1m': '1-minute averages',
    '1h': 'Hourly averages',
    '1d': 'Daily averages'
  }[resolution];
}

export interface Traffic {
  /** Bytes, rebuilt from the stored rates. */
  received: number;
  sent: number;
  /** False when the samples cover well under the window (collection stopped for part of it). */
  complete: boolean;
}

/** Below this share of the window covered by samples, totals are flagged as a lower bound. */
const COMPLETE_SHARE = 0.95;

/**
 * Bytes moved in a window, from the network rate series: every raw sample
 * is a rate over one poll interval, and a point stands for `count` of them,
 * so bytes = avg × count × interval. Time nothing was collected adds
 * nothing, which makes the result a lower bound across gaps.
 */
export function traffic(
  rx: SeriesPoint[],
  tx: SeriesPoint[],
  intervalMs: number,
  window: { from: number; to: number }
): Traffic {
  const bytes = (points: SeriesPoint[]) =>
    points.reduce((sum, p) => sum + p.avg * p.count * (intervalMs / 1000), 0);
  const coveredMs = rx.reduce((sum, p) => sum + p.count * intervalMs, 0);
  return {
    received: bytes(rx),
    sent: bytes(tx),
    complete: coveredMs >= COMPLETE_SHARE * (window.to - window.from)
  };
}
