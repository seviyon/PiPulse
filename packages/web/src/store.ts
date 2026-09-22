import type { Sample } from './types.js';

/** The dashboard's view of the data: newest value per metric plus a recent series for sparklines. */
export interface LiveState {
  latest: Record<string, Sample>;
  series: Record<string, Sample[]>;
}

export function emptyState(): LiveState {
  return { latest: {}, series: {} };
}

function newer(current: Sample | undefined, candidate: Sample): boolean {
  return current === undefined || candidate.ts > current.ts;
}

/**
 * Seeds one metric's series from /api/metrics/:id/history (ascending by ts),
 * keeping any live samples newer than the history that arrived while the
 * request was in flight.
 */
export function applyHistory(state: LiveState, metric: string, samples: Sample[]): LiveState {
  const last = samples.at(-1);
  const newerLive = (state.series[metric] ?? []).filter((point) => point.ts > (last?.ts ?? -1));
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
  if (last && sample.ts <= last.ts) return state;
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
