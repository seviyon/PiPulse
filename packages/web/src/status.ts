export type StatusLevel = 'ok' | 'warning' | 'critical';

export interface Status {
  level: StatusLevel;
  /** Plain-words reason, present whenever level isn't ok. */
  label?: string;
}

interface Threshold {
  atLeast: number;
  level: Exclude<StatusLevel, 'ok'>;
  label: string;
}

/**
 * Display-only thresholds, highest first. Real, configurable alert rules
 * arrive with the Phase 5 alerting engine; these just colour the dashboard.
 */
const thresholds: Record<string, Threshold[]> = {
  // The Pi firmware starts soft-throttling at 80 °C and hard-throttles at 85 °C.
  cpu_temperature: [
    { atLeast: 80, level: 'critical', label: 'Throttling likely' },
    { atLeast: 70, level: 'warning', label: 'Running hot' }
  ],
  disk_used: [
    { atLeast: 90, level: 'critical', label: 'Almost full' },
    { atLeast: 80, level: 'warning', label: 'Filling up' }
  ],
  cpu_load: [{ atLeast: 90, level: 'warning', label: 'Busy' }]
};

export function statusFor(metric: string, value: number): Status {
  const hit = thresholds[metric]?.find((threshold) => value >= threshold.atLeast);
  return hit ? { level: hit.level, label: hit.label } : { level: 'ok' };
}

/** The value a meter fills up to; undefined for metrics with no natural ceiling. */
const meterMaxima: Record<string, number> = {
  cpu_load: 100,
  disk_used: 100,
  cpu_temperature: 85
};

export function meterMax(metric: string): number | undefined {
  return meterMaxima[metric];
}
