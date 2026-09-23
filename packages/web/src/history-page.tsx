import { useEffect, useMemo, useState } from 'preact/hooks';
import { Chart } from './chart.js';
import { formatValue } from './format.js';
import {
  chartGroups,
  resolutionLabel,
  summarize,
  toChartData,
  traffic,
  type ChartGroup
} from './history.js';
import { RANGES, routeHash, type RangeId } from './router.js';
import type { Config, PluginInfo, Resolution, Series } from './types.js';

interface HistoryPageProps {
  config: Config;
  range: RangeId;
  /** Current time on the server's clock. */
  now(): number;
}

type Window = { from: number; to: number };

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; series: Record<string, Series>; window: Window };

function withUnit(value: number, unit: string): string {
  const { text, unit: shown } = formatValue(value, unit);
  return shown ? `${text} ${shown}` : text;
}

function describeWindow({ from, to }: Window): string {
  const format = (ts: number) =>
    new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return `${format(from)} to ${format(to)}`;
}

async function fetchSeries(
  metric: string,
  { from, to }: Window,
  resolution: Resolution | 'auto' = 'auto'
): Promise<Series> {
  const query = `from=${from}&to=${to}${resolution === 'auto' ? '' : `&resolution=${resolution}`}`;
  const response = await fetch(`/api/metrics/${metric}/series?${query}`);
  if (!response.ok) throw new Error(`series for ${metric} answered ${response.status}`);
  return (await response.json()) as Series;
}

/**
 * A chart's series, all at one resolution. The server picks per metric by
 * counting its rows, and paired metrics (network rx/tx, on separate timers)
 * can land either side of the point limit in the same window; so the first
 * metric picks and the rest follow, rather than one line smoothed and the
 * other not under a label true for only one of them. A lead with no
 * readings falls through to raw, which could pull days of raw rows for its
 * partner, so then the rest pick for themselves.
 */
async function fetchGroup(group: ChartGroup, window: Window): Promise<[string, Series][]> {
  const [first, ...rest] = group.metrics.map((metric) => metric.id);
  const lead = await fetchSeries(first!, window);
  const others = await Promise.all(
    rest.map((metric) =>
      fetchSeries(metric, window, lead.points.length > 0 ? lead.resolution : 'auto')
    )
  );
  return [[first!, lead], ...rest.map((metric, i): [string, Series] => [metric, others[i]!])];
}

/** The dashed core-count line and its plain-words note, for the load chart. */
function loadReference(group: ChartGroup, cpus: number | undefined) {
  if (group.id !== 'load_1' || !cpus) return undefined;
  return {
    line: { value: cpus, label: `${cpus} ${cpus === 1 ? 'core' : 'cores'}` },
    note: `Above ${cpus} means work is waiting for a CPU or for the disk.`
  };
}

/** "In this range: 5.9 GB received, 1.9 GB sent", from the network rate series. */
function TrafficLines({
  group,
  series,
  plugins,
  window
}: {
  group: ChartGroup;
  series: Record<string, Series>;
  plugins: PluginInfo[];
  window: Window;
}) {
  if (group.id !== 'network') return null;
  const intervalMs = plugins.find((p) => p.id === 'network_rx')?.intervalMs;
  const rx = series['network_rx']?.points ?? [];
  if (!intervalMs || rx.length === 0) return null;
  const total = traffic(rx, series['network_tx']?.points ?? [], intervalMs, window);
  return (
    <>
      <p class="summary">
        In this range: {withUnit(total.received, 'B')} received, {withUnit(total.sent, 'B')} sent
      </p>
      {!total.complete && (
        <p class="note">
          PiPulse wasn't collecting for all of this range, so these totals are a lower bound.
        </p>
      )}
    </>
  );
}

function GroupChart({
  group,
  series,
  config,
  window,
  onZoom
}: {
  group: ChartGroup;
  series: Record<string, Series>;
  config: Config;
  window: Window;
  onZoom(from: number, to: number): void;
}) {
  const reference = loadReference(group, config.device.cpus);
  const perMetric = group.metrics.map((metric) => series[metric.id]?.points ?? []);
  const data = useMemo(() => toChartData(perMetric), [series]);
  // From a metric with readings: an empty one's resolution says nothing about the chart.
  const shown = group.metrics.map((metric) => series[metric.id]);
  const resolution = (shown.find((s) => s && s.points.length > 0) ?? shown[0])?.resolution ?? 'raw';
  const band = group.metrics.length === 1 && resolution !== 'raw';
  const single = group.metrics.length === 1;

  const summaries = group.metrics.map((metric, i) => {
    const summary = summarize(perMetric[i]!);
    if (!summary) return null;
    const text = `low ${withUnit(summary.low, group.unit)}, average ${withUnit(summary.average, group.unit)}, high ${withUnit(summary.high, group.unit)}`;
    return single ? text.charAt(0).toUpperCase() + text.slice(1) : `${metric.label}: ${text}`;
  });

  return (
    <section class="history-chart" aria-labelledby={`chart-${group.id}`}>
      <div class="history-chart-head">
        <h2 id={`chart-${group.id}`}>{group.label}</h2>
        <p class="note">
          {resolutionLabel(resolution)}
          {band && '. The band spans each period’s low to high.'}
        </p>
      </div>
      {data[0]!.length === 0 ? (
        <p class="waiting">No readings in this range</p>
      ) : (
        <Chart
          data={data}
          labels={group.metrics.map((metric) => metric.label)}
          unit={group.unit}
          band={band}
          title={`${group.label}, ${resolutionLabel(resolution).toLowerCase()}`}
          {...(reference ? { reference: reference.line } : {})}
          onZoom={onZoom}
        />
      )}
      {summaries.map((text) => text && <p class="summary">{text}</p>)}
      {reference && <p class="note">{reference.note}</p>}
      <TrafficLines group={group} series={series} plugins={config.plugins} window={window} />
    </section>
  );
}

/**
 * Past readings for every chartable metric over a preset range, or over a
 * window dragged across any chart. The server picks the resolution for
 * each request, so zooming in fetches finer data rather than stretching
 * coarse points.
 */
export function HistoryPage({ config, range, now }: HistoryPageProps) {
  const groups = useMemo(() => chartGroups(config.plugins), [config]);
  // Tagged with its range, so a zoom never outlives a change of range: the
  // fetch below sees the new range unzoomed on the same render, rather than
  // refetching the stale zoom window first.
  const [zoomed, setZoomed] = useState<{ range: RangeId; window: Window }>();
  const zoom = zoomed?.range === range ? zoomed.window : undefined;
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** A request is in flight; the previous charts stay up, marked as updating. */
  const [pending, setPending] = useState(true);

  // Going back to a range later shouldn't bring its old zoom back.
  useEffect(() => setZoomed(undefined), [range]);

  useEffect(() => {
    const preset = RANGES.find((r) => r.id === range)!;
    const to = now();
    const window = zoom ?? { from: to - preset.ms, to };
    let cancelled = false;
    setPending(true);
    setLoad((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    Promise.all(groups.map((group) => fetchGroup(group, window))).then(
      (results) => {
        if (cancelled) return;
        setPending(false);
        setLoad({
          status: 'ready',
          series: Object.fromEntries(results.flat()),
          window
        });
      },
      () => {
        if (cancelled) return;
        setPending(false);
        setLoad({ status: 'error' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [range, zoom, attempt, groups]);

  return (
    <div class="history">
      <div class="history-controls">
        <nav aria-label="Time range" class="ranges">
          {RANGES.map((option) => (
            <a
              key={option.id}
              href={routeHash({ page: 'history', range: option.id })}
              aria-current={option.id === range && !zoom ? 'true' : undefined}
              // The current range's link leaves the hash unchanged, so no
              // hashchange would reset the zoom; clear it directly.
              onClick={() => setZoomed(undefined)}
            >
              {option.label}
            </a>
          ))}
        </nav>
        {zoom && (
          <p class="zoom">
            <span>{describeWindow(zoom)}</span>
            <button type="button" onClick={() => setZoomed(undefined)}>
              Reset zoom
            </button>
          </p>
        )}
      </div>

      {load.status === 'error' && (
        <div class="problem" role="alert">
          <h2>Couldn't load the history</h2>
          <p>The PiPulse server didn't answer the request.</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {pending && (
        <p class="waiting" role="status">
          {load.status === 'ready' ? 'Updating history' : 'Loading history'}
        </p>
      )}
      {load.status === 'ready' && (
        <div class="history-charts" aria-busy={pending ? 'true' : undefined}>
          {groups.map((group) => (
            <GroupChart
              key={group.id}
              group={group}
              series={load.series}
              config={config}
              window={load.window}
              onZoom={(from, to) => setZoomed({ range, window: { from, to } })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
