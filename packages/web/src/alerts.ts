import { formatValue } from './format.js';
import { RANGES, type RangeId } from './router.js';
import type { Alert, PluginInfo, Rule } from './types.js';

/** Applies one live raise or clear to the open alerts, newest first. */
export function applyAlertEvent(open: Alert[], event: 'raised' | 'cleared', alert: Alert): Alert[] {
  const rest = open.filter((a) => a.id !== alert.id);
  return event === 'raised' ? [alert, ...rest] : rest;
}

/** The alert to show for a group: critical before warning, then the one open longest. */
export function worstAlert(alerts: Alert[]): Alert | undefined {
  return [...alerts].sort(
    (a, b) =>
      Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
      a.raisedAt - b.raisedAt
  )[0];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The shortest History range that reaches back to `raisedAt`. */
export function rangeCovering(raisedAt: number, now: number): RangeId {
  return (RANGES.find((range) => range.ms >= now - raisedAt) ?? RANGES[RANGES.length - 1]!).id;
}

/** "30 s", "2 min", "2 h", "1 d": the largest unit that divides evenly. */
export function formatDuration(ms: number): string {
  if (ms >= DAY && ms % DAY === 0) return `${ms / DAY} d`;
  if (ms >= HOUR && ms % HOUR === 0) return `${ms / HOUR} h`;
  if (ms >= MIN && ms % MIN === 0) return `${ms / MIN} min`;
  return `${ms / 1000} s`;
}

/** A rule in words, e.g. "CPU temperature ≥ 70 °C for 10 min". */
export function describeRule(rule: Rule, plugins: PluginInfo[]): string {
  const plugin = plugins.find((p) => p.id === rule.metric);
  const name = rule.metric === '*' ? 'Any metric' : (plugin?.label ?? rule.metric);
  const withUnit = (value: number) => {
    const { text, unit } = formatValue(value, plugin?.unit ?? '');
    return unit ? `${text} ${unit}` : text;
  };
  const lasting = rule.forMs > 0 ? ` for ${formatDuration(rule.forMs)}` : '';
  if (rule.atLeast !== undefined) return `${name} ≥ ${withUnit(rule.atLeast)}${lasting}`;
  if (rule.atMost !== undefined) return `${name} ≤ ${withUnit(rule.atMost)}${lasting}`;
  if (rule.bitsSet !== undefined)
    return `${name}: flags 0x${rule.bitsSet.toString(16)} set${lasting}`;
  const silence =
    rule.noReadingFor === 'auto'
      ? '5 polls (at least 2 min)'
      : formatDuration(rule.noReadingFor ?? 0);
  return `${name}: no reading for ${silence}`;
}
