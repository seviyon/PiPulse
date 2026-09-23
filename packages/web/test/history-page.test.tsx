import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { Config, Series } from '../src/types.js';

/** Stand-in for uPlot (happy-dom has no canvas); records what the chart was given. */
class FakePlot {
  static instances: FakePlot[] = [];
  data: unknown;
  constructor(
    readonly opts: {
      series: { label?: string }[];
      hooks?: { setSelect?: ((u: unknown) => void)[]; draw?: ((u: unknown) => void)[] };
      scales?: { y?: { range?: (u: unknown, min: number, max: number) => [number, number] } };
    },
    data: unknown
  ) {
    this.data = data;
    FakePlot.instances.push(this);
  }
  setData(data: unknown) {
    this.data = data;
  }
  setSize() {}
  setSelect() {}
  destroy() {}
}

vi.mock('uplot', () => ({ default: FakePlot }));

const { HistoryPage } = await import('../src/history-page.js');

const NOW = 1_790_200_000_000;
const HOUR = 3_600_000;

const config: Config = {
  device: { hostname: 'Io', platform: 'linux', arch: 'arm' },
  plugins: [
    { id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 },
    { id: 'throttled', label: 'Throttling', unit: 'flags', intervalMs: 10000 },
    { id: 'network_rx', label: 'Network received', unit: 'B/s', intervalMs: 5000 },
    { id: 'network_tx', label: 'Network sent', unit: 'B/s', intervalMs: 5000 }
  ]
};

let requests: URL[];
let fail: boolean;
/** While set, series requests wait for it to resolve. */
let hold: Promise<void> | undefined;
let root: HTMLElement;
/** What the fake server picks for `resolution=auto`, per metric (default 1m). */
let autoResolution: Record<string, Series['resolution']>;
/** Metrics the fake server has no readings for. */
let noData: Set<string>;
/** Levels a metric has no rows at yet, e.g. too young for an hourly bucket. */
let emptyAt: Record<string, Series['resolution'][]>;

function seriesFor(metric: string, resolution: Series['resolution'] = '1m'): Series {
  const base = metric === 'cpu_load' ? 2 : 1000;
  return {
    resolution,
    points: [
      { ts: NOW - 2 * 60_000, avg: base, min: base / 2, max: base * 2, count: 12 },
      { ts: NOW - 60_000, avg: base * 3, min: base, max: base * 4, count: 12 }
    ]
  };
}

async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assertion();
  });
}

function chartSection(title: string): HTMLElement {
  const heading = [...root.querySelectorAll('h2')].find((h) => h.textContent === title);
  if (!heading) throw new Error(`no chart titled "${title}"`);
  return heading.closest('section')!;
}

beforeEach(() => {
  FakePlot.instances = [];
  requests = [];
  fail = false;
  hold = undefined;
  autoResolution = {};
  noData = new Set();
  emptyAt = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const parsed = new URL(url, 'http://io.lan:8889');
      requests.push(parsed);
      await hold;
      if (fail) return new Response('boom', { status: 500 });
      const metric = /\/api\/metrics\/(\w+)\/series/.exec(parsed.pathname)?.[1] ?? '';
      const asked = parsed.searchParams.get('resolution') as Series['resolution'] | null;
      const series = seriesFor(metric, asked ?? autoResolution[metric] ?? '1m');
      const empty = noData.has(metric) || emptyAt[metric]?.includes(series.resolution);
      return Response.json(empty ? { ...series, points: [] } : series);
    })
  );
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('<HistoryPage>', () => {
  it('draws one chart per group, skipping flags, with network directions together', async () => {
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(root.textContent).toContain('1-minute averages'));

    expect([...root.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'CPU load',
      'Network'
    ]);
    expect(FakePlot.instances.map((plot) => plot.opts.series.map((s) => s.label))).toEqual([
      [undefined, 'CPU load', 'Low', 'High'],
      [undefined, 'Received', 'Sent']
    ]);
  });

  it('requests the selected range for every charted metric', async () => {
    render(<HistoryPage config={config} range="7d" now={() => NOW} />, root);
    await eventually(() => expect(requests).toHaveLength(3));

    expect(requests.map((url) => url.pathname).sort()).toEqual([
      '/api/metrics/cpu_load/series',
      '/api/metrics/network_rx/series',
      '/api/metrics/network_tx/series'
    ]);
    for (const url of requests) {
      expect(url.searchParams.get('from')).toBe(String(NOW - 7 * 24 * HOUR));
      expect(url.searchParams.get('to')).toBe(String(NOW));
    }
  });

  it('summarises each chart in words with formatted values', async () => {
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() =>
      expect(chartSection('CPU load').textContent).toContain('Low 1 %, average 4 %, high 8 %')
    );
    expect(chartSection('Network').textContent).toContain(
      'Received: low 500 B/s, average 2 kB/s, high 4 kB/s'
    );
  });

  it('totals the traffic in the range, and says when collection gaps make it a lower bound', async () => {
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() =>
      expect(chartSection('Network').textContent).toContain(
        'In this range: 240 kB received, 240 kB sent'
      )
    );
    // Two minutes of samples in a 24-hour range.
    expect(chartSection('Network').textContent).toContain(
      "PiPulse wasn't collecting for all of this range, so these totals are a lower bound."
    );
  });

  it('marks the core count on the load chart and says what crossing it means', async () => {
    const withLoad: Config = {
      device: { ...config.device, cpus: 4 },
      plugins: [
        { id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 },
        { id: 'load_1', label: 'Load (1 min)', unit: '', intervalMs: 30000 }
      ]
    };
    render(<HistoryPage config={withLoad} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(root.textContent).toContain('Load (1 min)'));

    expect(chartSection('Load (1 min)').textContent).toContain(
      'Above 4 means work is waiting for a CPU or for the disk.'
    );
    const plot = FakePlot.instances.find((p) => p.opts.series[1]?.label === 'Load (1 min)')!;
    // The core count stays in view even when the load is far below it.
    expect(plot.opts.scales?.y?.range?.(undefined, 0.1, 0.5)[1]).toBeGreaterThan(4);
    expect(plot.opts.hooks?.draw).toHaveLength(1);
  });

  it('leaves the load chart unmarked when the server does not report its cores', async () => {
    const withLoad: Config = {
      ...config,
      plugins: [{ id: 'load_1', label: 'Load (1 min)', unit: '', intervalMs: 30000 }]
    };
    render(<HistoryPage config={withLoad} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(root.textContent).toContain('Load (1 min)'));

    expect(chartSection('Load (1 min)').textContent).not.toContain('Above');
    expect(FakePlot.instances[0]!.opts.hooks?.draw).toBeUndefined();
  });

  it('links every range, marking the current one', async () => {
    render(<HistoryPage config={config} range="30d" now={() => NOW} />, root);
    const links = [...root.querySelectorAll('nav[aria-label="Time range"] a')];
    expect(links.map((a) => a.textContent)).toEqual([
      '1 hour',
      '6 hours',
      '24 hours',
      '7 days',
      '30 days',
      '1 year'
    ]);
    expect(links.find((a) => a.getAttribute('aria-current') === 'true')?.textContent).toBe(
      '30 days'
    );
    expect(links[3]?.getAttribute('href')).toBe('#/history?range=7d');
  });

  it('refetches the window dragged across a chart, and resets back to the range', async () => {
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(FakePlot.instances).toHaveLength(2));

    const from = (NOW - 3 * HOUR) / 1000;
    const to = (NOW - 2 * HOUR) / 1000;
    requests = [];
    await act(() => {
      FakePlot.instances[0]!.opts.hooks!.setSelect![0]!({
        select: { left: from, width: to - from },
        posToVal: (value: number) => value,
        setSelect: () => {}
      });
    });
    await eventually(() => expect(requests).toHaveLength(3));
    expect(requests[0]?.searchParams.get('from')).toBe(String(NOW - 3 * HOUR));
    expect(requests[0]?.searchParams.get('to')).toBe(String(NOW - 2 * HOUR));

    const reset = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Reset zoom');
    expect(reset).toBeDefined();
    requests = [];
    await act(() => reset!.click());
    await eventually(() => expect(requests).toHaveLength(3));
    expect(requests[0]?.searchParams.get('from')).toBe(String(NOW - 24 * HOUR));
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Reset zoom')).toBe(
      false
    );
  });

  /** Drags across the first chart from `from` to `to` (unix ms). */
  async function dragZoom(from: number, to: number) {
    await act(() => {
      FakePlot.instances[0]!.opts.hooks!.setSelect![0]!({
        select: { left: from / 1000, width: (to - from) / 1000 },
        posToVal: (value: number) => value,
        setSelect: () => {}
      });
    });
  }

  it('resets the zoom from the current range link, which leaves the hash unchanged', async () => {
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(FakePlot.instances).toHaveLength(2));
    await dragZoom(NOW - 3 * HOUR, NOW - 2 * HOUR);
    await eventually(() => expect(root.textContent).toContain('Reset zoom'));

    requests = [];
    const current = [...root.querySelectorAll('.ranges a')].find(
      (a) => a.textContent === '24 hours'
    ) as HTMLAnchorElement;
    await act(() => current.click());
    await eventually(() => expect(requests).toHaveLength(3));
    expect(requests[0]?.searchParams.get('from')).toBe(String(NOW - 24 * HOUR));
    expect(root.textContent).not.toContain('Reset zoom');
  });

  it('fetches only the new range when the range changes while zoomed', async () => {
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(FakePlot.instances).toHaveLength(2));
    await dragZoom(NOW - 3 * HOUR, NOW - 2 * HOUR);
    await eventually(() => expect(root.textContent).toContain('Reset zoom'));

    requests = [];
    await act(() => {
      render(<HistoryPage config={config} range="7d" now={() => NOW} />, root);
    });
    await eventually(() => expect(requests).toHaveLength(3));
    await eventually(() => expect(root.textContent).not.toContain('Reset zoom'));
    expect(requests.map((r) => r.searchParams.get('from'))).toEqual(
      Array(3).fill(String(NOW - 7 * 24 * HOUR))
    );
  });

  it('marks the charts as updating while a new window loads', async () => {
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(FakePlot.instances).toHaveLength(2));
    expect(root.querySelector('[role="status"]')).toBeNull();

    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    await act(() => {
      render(<HistoryPage config={config} range="7d" now={() => NOW} />, root);
    });
    await eventually(() =>
      expect(root.querySelector('[role="status"]')?.textContent).toBe('Updating history')
    );
    expect(root.querySelector('.history-charts')?.getAttribute('aria-busy')).toBe('true');

    release();
    await eventually(() => expect(root.querySelector('[role="status"]')).toBeNull());
    expect(root.querySelector('.history-charts')?.hasAttribute('aria-busy')).toBe(false);
  });

  /** The series requests made for `id`, in order. */
  const requestsFor = (id: string) => requests.filter((r) => r.pathname.includes(`/${id}/`));
  const forced = (id: string) => requestsFor(id).map((r) => r.searchParams.get('resolution'));

  it('refetches the finer half of a pair at the coarser resolution, whichever metric comes first', async () => {
    // Near the point limit the server can pick differently for each direction.
    autoResolution = { network_rx: 'raw', network_tx: '1m' };
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(forced('network_rx')).toEqual([null, '1m']));

    expect(forced('network_tx')).toEqual([null]);
    expect(forced('cpu_load')).toEqual([null]);
    await eventually(() =>
      expect(chartSection('Network').textContent).toContain('1-minute averages')
    );
  });

  it('makes no second request when a pair agrees', async () => {
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(FakePlot.instances).toHaveLength(2));
    expect(requests).toHaveLength(3);
  });

  it('never forces a metric finer than it picked, so its partner cannot exceed the point limit', async () => {
    // A metric with readings for only part of the range fits finer data;
    // its partner, with the whole range, must not be pulled down to it.
    autoResolution = { network_rx: 'raw', network_tx: '1h' };
    render(<HistoryPage config={config} range="7d" now={() => NOW} />, root);
    await eventually(() => expect(forced('network_rx')).toEqual([null, '1h']));

    expect(forced('network_tx')).toEqual([null]);
  });

  it('leaves a metric with no readings out of the choice', async () => {
    // What the server picks for no rows (here raw) says nothing about the partner.
    autoResolution = { network_rx: 'raw', network_tx: '1h' };
    noData = new Set(['network_rx']);
    render(<HistoryPage config={config} range="7d" now={() => NOW} />, root);
    await eventually(() => expect(FakePlot.instances.length).toBeGreaterThan(0));

    expect(forced('network_rx')).toEqual([null]);
    expect(forced('network_tx')).toEqual([null]);
    expect(chartSection('Network').textContent).toContain('Hourly averages');
  });

  it('does not let an empty metric that picked days blank its partner on a young database', async () => {
    // Never collected, over a year: the server picks daily rows, of which a
    // day-old database has none; the partner keeps its own minutes.
    autoResolution = { network_rx: '1d', network_tx: '1m' };
    noData = new Set(['network_rx']);
    render(<HistoryPage config={config} range="1y" now={() => NOW} />, root);
    await eventually(() => expect(FakePlot.instances.length).toBeGreaterThan(0));

    expect(forced('network_tx')).toEqual([null]);
    expect(chartSection('Network').textContent).toContain('1-minute averages');
  });

  it('keeps a metric at its own pick when it has no rows yet at the coarser level', async () => {
    // Sent started half an hour ago: hourly has nothing for it, so moving it
    // to its partner's level would blank its line.
    autoResolution = { network_rx: '1h', network_tx: 'raw' };
    emptyAt = { network_tx: ['1h'] };
    render(<HistoryPage config={config} range="7d" now={() => NOW} />, root);
    await eventually(() => expect(forced('network_tx')).toEqual([null, '1h']));

    await eventually(() =>
      expect(chartSection('Network').textContent).toContain('Sent: low 500 B/s')
    );
    // Two resolutions on one chart: each line is labelled with its own.
    const label = 'Received: hourly averages. Sent: every reading';
    expect(chartSection('Network').querySelector('.note')?.textContent).toBe(label);
    expect(chartSection('Network').querySelector('.chart')?.getAttribute('aria-label')).toBe(
      `Network. ${label}`
    );
  });

  it('explains a failed load and retries on request', async () => {
    fail = true;
    render(<HistoryPage config={config} range="24h" now={() => NOW} />, root);
    await eventually(() => expect(root.textContent).toContain("Couldn't load the history"));

    fail = false;
    const retry = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    await act(() => retry!.click());
    await eventually(() => expect(root.textContent).toContain('1-minute averages'));
  });
});
