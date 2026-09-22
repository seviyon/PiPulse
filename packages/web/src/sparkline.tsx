import { useState } from 'preact/hooks';
import { formatValue } from './format.js';
import type { Sample } from './types.js';

const WIDTH = 300;
const HEIGHT = 48;

interface SparklineProps {
  series: Sample[];
  unit: string;
  label: string;
  /** Right edge of the time axis (unix ms); the left edge is `end - windowMs`. */
  end: number;
  windowMs: number;
}

/** Centres the readout on the cursor, but pins it inside the tile near either edge. */
function tipPosition(fraction: number) {
  const left = `${fraction * 100}%`;
  if (fraction < 0.2) return { left, transform: 'translateX(-10%)' };
  if (fraction > 0.8) return { left, transform: 'translateX(-90%)' };
  return { left, transform: 'translateX(-50%)' };
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function describe(value: number, unit: string): string {
  const { text, unit: shown } = formatValue(value, unit);
  return `${text} ${shown}`;
}

/**
 * The last `windowMs` of a metric as a thin line over a faint wash, with an
 * end dot on the newest reading and a hover/touch readout. The time axis is
 * fixed to the window, so gaps in collection show as gaps, not as a squeeze.
 */
export function Sparkline({ series, unit, label, end, windowMs }: SparklineProps) {
  const [hover, setHover] = useState<Sample>();
  if (series.length < 2) return null;

  const start = end - windowMs;
  const values = series.map((sample) => sample.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A floor on the span keeps sensor noise (1.2 % vs 1.3 %) from looking like a spike.
  const span = Math.max(high - low, Math.abs(high) * 0.1, 1);
  const mid = (high + low) / 2;
  const yMin = mid - span / 2;

  const x = (ts: number) => ((ts - start) / windowMs) * WIDTH;
  const y = (value: number) => HEIGHT - ((value - yMin) / span) * HEIGHT;
  const points = series.map((sample) => `${x(sample.ts).toFixed(1)},${y(sample.value).toFixed(1)}`);
  const first = series[0]!;
  const last = series.at(-1)!;
  const line = `M${points.join('L')}`;
  const area = `${line}L${x(last.ts).toFixed(1)},${HEIGHT}L${x(first.ts).toFixed(1)},${HEIGHT}Z`;

  const pct = (sample: Sample) => ({
    left: `${(x(sample.ts) / WIDTH) * 100}%`,
    top: `${(y(sample.value) / HEIGHT) * 100}%`
  });

  const pick = (event: PointerEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ts = start + ((event.clientX - box.left) / box.width) * windowMs;
    let nearest = first;
    for (const sample of series) {
      if (Math.abs(sample.ts - ts) < Math.abs(nearest.ts - ts)) nearest = sample;
    }
    setHover(nearest);
  };

  const minutes = Math.round(windowMs / 60_000);

  return (
    <div>
      <div
        class="spark"
        role="img"
        aria-label={`${label} over the last ${minutes} minutes: low ${describe(low, unit)}, high ${describe(high, unit)}`}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(undefined)}
      >
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <path class="area" d={area} />
          {hover && (
            <line
              class="cursor"
              x1={x(hover.ts)}
              x2={x(hover.ts)}
              y1={0}
              y2={HEIGHT}
              vector-effect="non-scaling-stroke"
            />
          )}
          <path class="line" d={line} vector-effect="non-scaling-stroke" />
        </svg>
        <span class="dot" style={pct(hover ?? last)} />
        {hover && (
          <span class="tip" style={tipPosition(x(hover.ts) / WIDTH)}>
            {describe(hover.value, unit)}
            <time dateTime={new Date(hover.ts).toISOString()}>{clock(hover.ts)}</time>
          </span>
        )}
      </div>
      <div class="spark-range" aria-hidden="true">
        <span>{minutes} min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
