/**
 * Tile status and meters. Status levels and their words come from the
 * alert rules the server sends (see statusFor below), not fixed
 * thresholds; meters still use fixed maxima, purely for display.
 */
import type { Rule } from './types.js';

export type StatusLevel = 'ok' | 'warning' | 'critical';

export interface Status {
  level: StatusLevel;
  /** Plain-words reason, present whenever level isn't ok. */
  label?: string;
}

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

const rank = { warning: 1, critical: 2 } as const;

function holds(rule: Rule, value: number): boolean {
  if (rule.atLeast !== undefined) return value >= rule.atLeast;
  if (rule.atMost !== undefined) return value <= rule.atMost;
  if (rule.bitsSet !== undefined) return (value & rule.bitsSet) !== 0;
  return false;
}

/** Throttle bits in words: happening now, else since boot, else the rule's own message. */
function throttleLabel(rule: Rule, value: number): string {
  const bits = value & (rule.bitsSet ?? 0);
  if (bits & 0xf) return describeThrottle(bits & 0xf);
  if ((bits >> 16) & 0xf) return `${describeThrottle((bits >> 16) & 0xf)} since boot`;
  return rule.message;
}

/**
 * A tile's status from the alert rules for its metric, judged on the one
 * reading shown (alerts wait for their `for`; tiles react at once). The
 * most severe matching rule wins and names it in words.
 */
export function statusFor(rules: Rule[], metric: string, value: number): Status {
  let worst: Rule | undefined;
  for (const rule of rules) {
    if (rule.metric !== metric || !holds(rule, value)) continue;
    if (!worst || rank[rule.severity] > rank[worst.severity]) worst = rule;
  }
  if (!worst) return { level: 'ok' };
  return {
    level: worst.severity,
    label: metric === 'throttled' ? throttleLabel(worst, value) : worst.message
  };
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
