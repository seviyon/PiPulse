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
  boot_used: [
    { atLeast: 90, level: 'critical', label: 'Almost full' },
    { atLeast: 80, level: 'warning', label: 'Filling up' }
  ],
  // Constant swapping on an SD card is slow and wears the card out.
  swap_used: [
    { atLeast: 95, level: 'critical', label: 'Swap nearly full' },
    { atLeast: 80, level: 'warning', label: 'Swapping heavily' }
  ],
  cpu_load: [{ atLeast: 90, level: 'warning', label: 'Busy' }]
};

/** vcgencmd get_throttled bits 0–3; the same conditions since boot sit 16 bits higher. */
const throttleConditions = [
  [0x1, 'under-voltage'],
  [0x2, 'frequency capped'],
  [0x4, 'throttled'],
  [0x8, 'soft temperature limit']
] as const;

function describeThrottle(bits: number): string {
  const text = throttleConditions
    .filter(([bit]) => (bits & bit) !== 0)
    .map(([, name]) => name)
    .join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function statusFor(metric: string, value: number): Status {
  if (metric === 'throttled') {
    const now = value & 0xf;
    const sinceBoot = (value >> 16) & 0xf;
    if (now) return { level: 'critical', label: describeThrottle(now) };
    if (sinceBoot) return { level: 'warning', label: `${describeThrottle(sinceBoot)} since boot` };
    return { level: 'ok' };
  }
  const hit = thresholds[metric]?.find((threshold) => value >= threshold.atLeast);
  return hit ? { level: hit.level, label: hit.label } : { level: 'ok' };
}

/** The value a meter fills up to; undefined for metrics with no natural ceiling. */
const meterMaxima: Record<string, number> = {
  cpu_load: 100,
  disk_used: 100,
  boot_used: 100,
  swap_used: 100,
  cpu_temperature: 85
};

/**
 * Metrics whose meter is a share of a capacity, worth spelling out as
 * "25% of 972 MB". Not temperature: 85 °C is a throttle limit, and a
 * percentage of a Celsius value means nothing.
 */
const shareMetrics = new Set(['memory_used']);

export function showsShareOfMax(metric: string): boolean {
  return shareMetrics.has(metric);
}

export function meterMax(
  metric: string,
  device: { memoryTotalMb?: number } = {}
): number | undefined {
  if (metric === 'memory_used') return device.memoryTotalMb;
  return meterMaxima[metric];
}
