import { useEffect, useRef, useState } from 'preact/hooks';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { formatValue } from './format.js';

interface ChartProps {
  /**
   * uPlot columns: x in seconds, one avg column per label, then min and max
   * when `band`. `null` breaks a line; `undefined` is drawn through.
   */
  data: (number | null | undefined)[][];
  labels: string[];
  unit: string;
  /** Shade between the min and max columns (single-series rollups). */
  band: boolean;
  title: string;
  /** A dashed horizontal line kept in view, e.g. the core count on the load chart. */
  reference?: { value: number; label: string };
  /** Called with the dragged-over window, in unix ms. */
  onZoom(from: number, to: number): void;
}

const HEIGHT = 200;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatTick(value: number, unit: string): string {
  const { text, unit: shown } = formatValue(value, unit);
  return shown ? `${text} ${shown}` : text;
}

/** Re-renders when the OS switches light/dark, so the chart picks up the new colours. */
function useColorScheme(): string {
  const query =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const [scheme, setScheme] = useState(query?.matches ? 'dark' : 'light');
  useEffect(() => {
    if (!query) return;
    const update = () => setScheme(query.matches ? 'dark' : 'light');
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return scheme;
}

/** Draws `reference` as a dashed line across the plot, labelled at its right end. */
function drawReference(
  u: uPlot,
  reference: { value: number; label: string },
  color: string,
  font: string
) {
  const { ctx, bbox } = u;
  const y = Math.round(u.valToPos(reference.value, 'y', true)) + 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = devicePixelRatio;
  ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
  ctx.beginPath();
  ctx.moveTo(bbox.left, y);
  ctx.lineTo(bbox.left + bbox.width, y);
  ctx.stroke();
  ctx.font = `${12 * devicePixelRatio}px ${font}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(reference.label, bbox.left + bbox.width, y - 2 * devicePixelRatio);
  ctx.restore();
}

/**
 * A time-series chart: 2px average lines, an optional low–high band as a
 * faint wash, hairline grid, and uPlot's legend as the hover readout.
 * Dragging across it reports the window through `onZoom` instead of
 * zooming in place, so the page can refetch it at a finer resolution.
 */
export function Chart({ data, labels, unit, band, title, reference, onZoom }: ChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot>();
  const zoom = useRef(onZoom);
  zoom.current = onZoom;
  const scheme = useColorScheme();

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    const colors = [cssVar('--series-1'), cssVar('--series-2')];
    const hairline = cssVar('--hairline');
    const muted = cssVar('--ink-3');
    const value = (_u: uPlot, v: number | null | undefined) =>
      v == null ? '–' : formatTick(v, unit);

    const series: uPlot.Series[] = [
      {},
      ...labels.map((label, i) => ({
        label,
        stroke: colors[i % colors.length]!,
        width: 2,
        points: { show: false },
        value
      }))
    ];
    if (band) {
      series.push(
        { label: 'Low', stroke: 'transparent', points: { show: false }, value },
        { label: 'High', stroke: 'transparent', points: { show: false }, value }
      );
    }
    const axis = {
      stroke: muted,
      grid: { stroke: hairline, width: 1 },
      ticks: { stroke: hairline, width: 1 }
    };

    const instance = new uPlot(
      {
        width: target.clientWidth || 600,
        height: HEIGHT,
        series,
        ...(band
          ? { bands: [{ series: [3, 2] as [number, number], fill: cssVar('--accent-wash') }] }
          : {}),
        scales: {
          x: { time: true },
          ...(reference
            ? {
                y: {
                  range: (_u: uPlot, min: number, max: number): uPlot.Range.MinMax => [
                    Math.min(0, min),
                    Math.max(max, reference.value) * 1.1
                  ]
                }
              }
            : {})
        },
        axes: [
          axis,
          { ...axis, size: 70, values: (_u, ticks) => ticks.map((tick) => formatTick(tick, unit)) }
        ],
        cursor: { drag: { x: true, y: false, setScale: false } },
        hooks: {
          ...(reference
            ? { draw: [(u: uPlot) => drawReference(u, reference, muted, cssVar('--font'))] }
            : {}),
          setSelect: [
            (u) => {
              if (u.select.width <= 0) return;
              const from = u.posToVal(u.select.left, 'x');
              const to = u.posToVal(u.select.left + u.select.width, 'x');
              u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
              zoom.current(Math.round(from * 1000), Math.round(to * 1000));
            }
          ]
        }
      },
      data as uPlot.AlignedData,
      target
    );
    plot.current = instance;

    const resize = new ResizeObserver(() => {
      instance.setSize({ width: target.clientWidth, height: HEIGHT });
    });
    resize.observe(target);
    return () => {
      resize.disconnect();
      instance.destroy();
      plot.current = undefined;
    };
    // Rebuilt when the series shape or theme changes; data alone is swapped in below.
  }, [labels.join('\n'), unit, band, scheme, reference?.value, reference?.label]);

  useEffect(() => {
    plot.current?.setData(data as uPlot.AlignedData);
  }, [data]);

  return <div class="chart" ref={container} role="img" aria-label={title} />;
}
