/** Wire types for the PiPulse API (mirrors packages/api; kept local so the browser bundle never imports server code). */
export interface Sample {
  ts: number;
  metric: string;
  value: number;
}

export interface PluginInfo {
  id: string;
  label: string;
  unit: string;
  intervalMs: number;
}

export interface DeviceInfo {
  hostname: string;
  platform: string;
  arch: string;
  model?: string;
  os?: string;
  kernel?: string;
  memoryTotalMb?: number;
  /** Logical CPUs; absent from older servers. */
  cpus?: number;
}

export type Severity = 'warning' | 'critical';

/** An effective alert rule from /api/config (mirrors @pipulse/alerts' Rule). */
export interface Rule {
  id: string;
  metric: string;
  atLeast?: number;
  atMost?: number;
  bitsSet?: number;
  noReadingFor?: number | 'auto';
  forMs: number;
  clearAfterMs: number;
  severity: Severity;
  message: string;
  source: 'built-in' | 'file' | 'saved';
}

export type RuleKind = 'built-in' | 'file' | 'edited' | 'added';

/** One row of the rules editor, from GET /api/alerts/rules (mirrors @pipulse/alerts). */
export interface RuleEntry {
  id: string;
  kind: RuleKind;
  disabled: boolean;
  rule: Rule | null;
  /** The rule in the rules-file format ("10min", 0xf as a number). */
  written: Record<string, unknown> | null;
  overrides: Rule | null;
  problem: string | null;
  saved: boolean;
}

export interface Alert {
  id: number;
  ruleId: string;
  metric: string;
  severity: Severity;
  message: string;
  value: number | null;
  raisedAt: number;
  clearedAt: number | null;
  clearedBy: 'condition' | 'rule_removed' | 'rule_changed' | null;
  /** When acknowledged; absent from older servers. */
  acknowledgedAt?: number | null;
}

export interface Config {
  device: DeviceInfo;
  plugins: PluginInfo[];
  /** The server's clock (unix ms) when it answered; absent from older servers. */
  serverTime?: number;
  /** Time since the Pi booted, in ms, when the server answered. */
  uptimeMs?: number;
  /** The effective alert rules; absent from older servers. */
  rules?: Rule[];
}

export type LiveMessage =
  | { type: 'snapshot'; samples: Sample[]; alerts?: Alert[] }
  | ({ type: 'sample' } & Sample)
  | { type: 'alert'; event: 'raised' | 'cleared' | 'acknowledged'; alert: Alert }
  | { type: 'rules'; rules: Rule[] };

export type Resolution = 'raw' | '1m' | '1h' | '1d';

/** One chart point from /api/metrics/:id/series; for raw samples avg = min = max. */
export interface SeriesPoint {
  ts: number;
  avg: number;
  min: number;
  max: number;
  /** Raw samples the point stands for: 1 for a raw sample, the bucket's count for a rollup. */
  count: number;
}

export interface Series {
  resolution: Resolution;
  points: SeriesPoint[];
}
