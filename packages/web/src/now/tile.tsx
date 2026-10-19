import { formatAge, formatTime, formatUptime, formatValue } from '../core/format.js';
import { Sparkline } from './sparkline.js';
import { StatusIcon } from '../core/status-icon.js';
import { showsShareOfMax, statusFor } from './status.js';
import { isStale } from '../core/store.js';
import type { Alert, PluginInfo, Rule, Sample } from '../core/types.js';

interface TileProps {
  plugin: PluginInfo;
  rules: Rule[];
  alert?: Alert | undefined;
  latest: Sample | undefined;
  series: Sample[];
  now: number;
  /** When the dashboard started waiting for data (page load); used to spot missing sensors. */
  waitingSince: number;
  windowMs: number;
  /** Full scale for the meter; no meter when omitted. */
  max?: number | undefined;
}

/** One metric: its current reading, a meter when it has a ceiling, and a recent trend. */
export function Tile({
  plugin,
  rules,
  alert,
  latest,
  series,
  now,
  waitingSince,
  windowMs,
  max
}: TileProps) {
  if (plugin.unavailable) {
    return (
      <section class="tile" aria-labelledby={`tile-${plugin.id}`}>
        <div class="tile-head">
          <h2 id={`tile-${plugin.id}`}>{plugin.label}</h2>
        </div>
        <p class="waiting">{plugin.unavailable}</p>
      </section>
    );
  }
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
  const status = statusFor(rules, plugin.id, latest.value);
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
        {alert && (
          <p
            class="note alert-line"
            data-severity={alert.severity}
            data-acknowledged={alert.acknowledgedAt ? 'true' : undefined}
          >
            <StatusIcon level={alert.severity} />
            Alert since {formatTime(alert.raisedAt)} ({formatUptime(now - alert.raisedAt)})
            {alert.acknowledgedAt ? ' · acknowledged' : ''}
          </p>
        )}
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
