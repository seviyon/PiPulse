import { formatAge, formatValue } from './format.js';
import { Sparkline } from './sparkline.js';
import { showsShareOfMax, statusFor, type StatusLevel } from './status.js';
import { isStale } from './store.js';
import type { PluginInfo, Sample } from './types.js';

interface TileProps {
  plugin: PluginInfo;
  latest: Sample | undefined;
  series: Sample[];
  now: number;
  /** When the dashboard started waiting for data (page load); used to spot missing sensors. */
  waitingSince: number;
  windowMs: number;
  /** Full scale for the meter; no meter when omitted. */
  max?: number | undefined;
}

function StatusIcon({ level }: { level: Exclude<StatusLevel, 'ok'> }) {
  return level === 'critical' ? (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M4.1 0.5h5.8l3.6 3.6v5.8l-3.6 3.6H4.1L0.5 9.9V4.1z" fill="var(--critical)" />
      <path d="M7 3.5v4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="7" cy="10.2" r="1" fill="#fff" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 0.8l6.4 12H0.6z" fill="var(--warning)" stroke-linejoin="round" />
      <path d="M7 5v3.6" stroke="#17202b" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="7" cy="10.6" r="0.9" fill="#17202b" />
    </svg>
  );
}

/** One metric: its current reading, a meter when it has a ceiling, and a recent trend. */
export function Tile({ plugin, latest, series, now, waitingSince, windowMs, max }: TileProps) {
  if (!latest) {
    // Same rule as a stale value: three missed polls.
    const missing = now - waitingSince > plugin.intervalMs * 3;
    return (
      <section class="tile" aria-labelledby={`tile-${plugin.id}`}>
        <div class="tile-head">
          <h2 id={`tile-${plugin.id}`}>{plugin.label}</h2>
        </div>
        <p class="waiting">
          {missing
            ? 'No readings yet. This device may not have this sensor.'
            : 'Waiting for the first reading'}
        </p>
      </section>
    );
  }

  const { text, unit } = formatValue(latest.value, plugin.unit);
  const status = statusFor(plugin.id, latest.value);
  const stale = isStale(latest, plugin.intervalMs, now);
  // A bitmask has no magnitude to meter or trend.
  const isFlags = plugin.unit === 'flags';

  return (
    <section
      class="tile"
      aria-labelledby={`tile-${plugin.id}`}
      data-status={status.level}
      data-stale={stale || undefined}
    >
      <div class="tile-head">
        <h2 id={`tile-${plugin.id}`}>{plugin.label}</h2>
        {status.level !== 'ok' && (
          <p class="status">
            <StatusIcon level={status.level} />
            {status.label}
          </p>
        )}
      </div>
      <div>
        <p class="reading">
          <span class="value">{text}</span>
          <span class="unit">{unit}</span>
        </p>
        {stale && <p class="note">No update since {formatAge(now - latest.ts)}</p>}
      </div>
      <div class="tile-foot">
        {max !== undefined && showsShareOfMax(plugin.id) && (
          <p class="note">
            {Math.round((latest.value / max) * 100)}% of {formatValue(max, plugin.unit).text}{' '}
            {formatValue(max, plugin.unit).unit}
          </p>
        )}
        {max !== undefined && !isFlags && (
          <div
            class="meter"
            role="meter"
            aria-label={`${plugin.label} out of ${max} ${plugin.unit}`}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={latest.value}
          >
            <div
              class="meter-fill"
              style={{ width: `${Math.min(100, Math.max(0, (latest.value / max) * 100))}%` }}
            />
          </div>
        )}
        {!isFlags && (
          <Sparkline
            series={series}
            unit={plugin.unit}
            label={plugin.label}
            end={now}
            windowMs={windowMs}
          />
        )}
      </div>
    </section>
  );
}
