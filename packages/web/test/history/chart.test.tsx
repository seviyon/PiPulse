import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { formatValue } from '../../src/core/format.js';

type Hook = (u: unknown) => void;
interface Opts {
  height: number;
  series: { label?: string; value?: (u: unknown, v: number | null | undefined) => string }[];
  bands?: unknown[];
  scales: {
    y?: { range: (u: unknown, min: number, max: number) => [number, number] };
  };
  axes: { values?: (u: unknown, ticks: number[]) => string[] }[];
  hooks: { draw?: Hook[]; setSelect?: Hook[] };
}

/** Stand-in for uPlot (happy-dom has no canvas); records what the chart was given. */
class FakePlot {
  static instances: FakePlot[] = [];
  data: unknown;
  destroyed = false;
  sizes: { width: number; height: number }[] = [];
  constructor(
    readonly opts: Opts,
    data: unknown
  ) {
    this.data = data;
    FakePlot.instances.push(this);
  }
  setData(data: unknown) {
    this.data = data;
  }
  setSize(size: { width: number; height: number }) {
    this.sizes.push(size);
  }
  destroy() {
    this.destroyed = true;
  }
}
vi.mock('uplot', () => ({ default: FakePlot }));

const { Chart } = await import('../../src/history/chart.js');

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}

/** A color-scheme query the test can flip. */
function stubColorScheme(initiallyDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initiallyDark,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    listeners,
    flip() {
      query.matches = !query.matches;
      for (const listener of [...listeners]) listener();
    }
  };
}

const data = [
  [1, 2, 3],
  [10, 20, 30]
];
let root: HTMLElement;
beforeEach(() => {
  FakePlot.instances = [];
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  stubColorScheme(false);
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

const draw = (props: Partial<Parameters<typeof Chart>[0]> = {}) =>
  act(() =>
    render(
      <Chart
        data={data}
        labels={['CPU load']}
        unit="%"
        band={false}
        title="CPU load"
        onZoom={() => {}}
        {...props}
      />,
      root
    )
  );
const plot = () => FakePlot.instances.at(-1)!;

describe('Chart, what it hands to uPlot', () => {
  it('formats readouts and axis ticks with the unit, and shows a dash for no value', async () => {
    await draw();
    const { text, unit } = formatValue(42, '%');
    const shown = unit ? `${text} ${unit}` : text;
    expect(plot().opts.series[1]!.value!(null, 42)).toBe(shown);
    expect(plot().opts.series[1]!.value!(null, null)).toBe('–');
    expect(plot().opts.series[1]!.value!(null, undefined)).toBe('–');
    expect(plot().opts.axes[1]!.values!(null, [42])).toEqual([shown]);
  });

  it('formats a unit with no symbol without a trailing space', async () => {
    await draw({ unit: '' });
    const ticks = plot().opts.axes[1]!.values!(null, [5]);
    expect(ticks[0]).toBe(formatValue(5, '').text);
    expect(ticks[0]).not.toMatch(/\s$/);
  });

  it('adds a low and a high series and a band only for a single-series rollup', async () => {
    await draw({
      band: true,
      data: [
        [1, 2],
        [1, 2],
        [0, 1],
        [2, 3]
      ]
    });
    expect(plot().opts.series.map((s) => s.label)).toEqual([undefined, 'CPU load', 'Low', 'High']);
    expect(plot().opts.bands).toHaveLength(1);
    await draw({ band: false });
    expect(plot().opts.bands).toBeUndefined();
  });

  it('has no fixed y range and no draw hook without a reference line', async () => {
    await draw();
    expect(plot().opts.scales.y).toBeUndefined();
    expect(plot().opts.hooks.draw).toBeUndefined();
    expect(plot().opts.hooks.setSelect).toHaveLength(1);
  });
});

describe('Chart, a reference line', () => {
  const reference = { value: 4, label: '4 cores' };

  it('keeps the line in view: the range reaches zero and the line, with 10 % headroom', async () => {
    await draw({ reference });
    const range = plot().opts.scales.y!.range;
    expect(range(null, 1, 2)).toEqual([0, 4 * 1.1]); // below the line: the line sets the top
    expect(range(null, 1, 10)).toEqual([0, 10 * 1.1]); // above it: the data does
    expect(range(null, -3, 2)).toEqual([-3, 4 * 1.1]); // below zero: the data sets the bottom
  });

  it('draws a dashed line across the plot, labelled at its right end', async () => {
    await draw({ reference });
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push([name, ...args]);
    const ctx = Object.fromEntries(
      ['save', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fillText', 'restore', 'setLineDash'].map(
        (name) => [name, record(name)]
      )
    );
    const u = {
      ctx,
      bbox: { left: 10, width: 200 },
      valToPos: (value: number, scale: string, canvas: boolean) => {
        expect([value, scale, canvas]).toEqual([4, 'y', true]);
        return 99.6;
      }
    };
    plot().opts.hooks.draw![0]!(u);
    const names = calls.map((c) => c[0]);
    expect(names).toEqual([
      'save',
      'setLineDash',
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke',
      'fillText',
      'restore'
    ]);
    expect(calls.find((c) => c[0] === 'moveTo')).toEqual(['moveTo', 10, 100.5]);
    expect(calls.find((c) => c[0] === 'lineTo')).toEqual(['lineTo', 210, 100.5]);
    const [, label, x, y] = calls.find((c) => c[0] === 'fillText')!;
    expect([label, x]).toEqual(['4 cores', 210]);
    expect(y as number).toBeLessThan(100.5); // above the line
  });
});

describe('Chart, life cycle', () => {
  it('swaps new data in without rebuilding the plot', async () => {
    await draw();
    const first = plot();
    const next = [
      [4, 5],
      [40, 50]
    ];
    await draw({ data: next });
    expect(FakePlot.instances).toHaveLength(1);
    expect(first.data).toBe(next);
  });

  it('rebuilds when the series shape changes, destroying the old plot', async () => {
    await draw();
    const first = plot();
    await draw({ unit: 'B/s' });
    expect(FakePlot.instances).toHaveLength(2);
    expect(first.destroyed).toBe(true);
  });

  it('resizes the plot to its container when the container resizes', async () => {
    await draw();
    FakeResizeObserver.instances[0]!.callback();
    expect(plot().sizes).toEqual([{ width: expect.any(Number), height: 200 }]);
  });

  it('stops observing and destroys the plot when it leaves the page', async () => {
    await draw();
    const first = plot();
    await act(() => render(null, root));
    expect(first.destroyed).toBe(true);
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);
  });

  it('draws again with the new colours when the OS switches between light and dark', async () => {
    const scheme = stubColorScheme(false);
    await draw();
    expect(FakePlot.instances).toHaveLength(1);
    await act(() => scheme.flip());
    expect(FakePlot.instances).toHaveLength(2);
    expect(FakePlot.instances[0]!.destroyed).toBe(true);
    await act(() => render(null, root));
    expect(scheme.listeners.size).toBe(0);
  });

  it('draws without a color-scheme query where the browser has none', async () => {
    vi.stubGlobal('matchMedia', undefined);
    await draw();
    expect(FakePlot.instances).toHaveLength(1);
  });
});
