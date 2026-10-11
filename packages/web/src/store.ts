import type { Sample } from './types.js';

/** The dashboard's view of the data: newest value per metric plus a recent series for sparklines. */
export interface LiveState {
  latest: Record<string, Sample>;
  series: Record<string, Sample[]>;
}

export function emptyState(): LiveState {
  return { latest: {}, series: {} };
}

/**
 * A reading this much older than the one we hold is not a late arrival: the Pi's clock stepped
 * back (it has no RTC; NTP corrects it after boot or a bad answer). Anything closer is a duplicate
 * or out of order and is dropped; anything further starts again from the new time instead of
 * waiting for it to catch up with the old one.
 */
const CLOCK_STEP_MS = 5 * 60_000;

function newer(current: Sample | undefined, candidate: Sample): boolean {
  return (
    current === undefined || candidate.ts > current.ts || candidate.ts < current.ts - CLOCK_STEP_MS
  );
}

/**
 * Seeds one metric's series from /api/metrics/:id/history (ascending by ts),
 * keeping any live samples newer than the history that arrived while the
 * request was in flight.
 */
export function applyHistory(state: LiveState, metric: string, samples: Sample[]): LiveState {
  const last = samples.at(-1);
  // Live points a few seconds past the history arrived while it was in flight; ones minutes past it
  // were stamped by a clock that read ahead since.
  const newerLive = (state.series[metric] ?? []).filter(
    (point) => last === undefined || (point.ts > last.ts && point.ts <= last.ts + CLOCK_STEP_MS)
  );
  return {
    series: { ...state.series, [metric]: [...samples, ...newerLive] },
    latest:
      last && newer(state.latest[metric], last) ? { ...state.latest, [metric]: last } : state.latest
  };
}

/** Takes the WebSocket's on-connect snapshot as latest values, never regressing a newer one. */
export function applySnapshot(state: LiveState, samples: Sample[]): LiveState {
  const latest = { ...state.latest };
  for (const sample of samples) {
    if (newer(latest[sample.metric], sample)) latest[sample.metric] = sample;
  }
  return { ...state, latest };
}

/** Appends one live sample, dropping duplicates and points older than `windowMs`. */
export function applySample(state: LiveState, sample: Sample, windowMs: number): LiveState {
  const series = state.series[sample.metric] ?? [];
  const last = series.at(-1);
  if (last && sample.ts <= last.ts) {
    if (sample.ts >= last.ts - CLOCK_STEP_MS) return state;
    // The clock stepped back: this is the present, the series so far is from a time that did not happen.
    return {
      series: { ...state.series, [sample.metric]: [sample] },
      latest: { ...state.latest, [sample.metric]: sample }
    };
  }
  const cutoff = sample.ts - windowMs;
  return {
    series: {
      ...state.series,
      [sample.metric]: [...series.filter((point) => point.ts >= cutoff), sample]
    },
    latest: newer(state.latest[sample.metric], sample)
      ? { ...state.latest, [sample.metric]: sample }
      : state.latest
  };
}

/** True once a metric has missed three of its polls in a row. */
export function isStale(sample: Sample, intervalMs: number, now: number): boolean {
  return now - sample.ts > intervalMs * 3;
}
