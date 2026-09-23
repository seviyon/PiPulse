import { readFileSync } from 'node:fs';
import { parseDuration } from '@pipulse/storage';

export type Severity = 'warning' | 'critical';

/** A resolved rule: built-in or from the rules file, durations in ms. */
export interface Rule {
  id: string;
  /** A plugin id, or '*' for every plugin (noReadingFor only). */
  metric: string;
  atLeast?: number;
  atMost?: number;
  bitsSet?: number;
  /** ms, or 'auto': 5 × the metric's poll interval, at least 2 minutes. */
  noReadingFor?: number | 'auto';
  forMs: number;
  clearAfterMs: number;
  severity: Severity;
  message: string;
  source: 'built-in' | 'file';
}

export interface MetricInfo {
  id: string;
  intervalMs: number;
}

export interface RulesFile {
  name: string;
  text: string;
}

/** A problem with the rules; its message is one line meant for the operator. */
export class AlertRulesError extends Error {}

const MIN = 60_000;

/**
 * The rules PiPulse ships with. Temperatures suit a Pi 5 with active
 * cooling (busy ≈ 55–65 °C) and a passively cooled Pi 2 alike.
 */
export function builtinRules(cores: number): Rule[] {
  const rule = (r: Omit<Rule, 'source' | 'clearAfterMs'> & { clearAfterMs?: number }): Rule => ({
    ...r,
    clearAfterMs: r.clearAfterMs ?? r.forMs,
    source: 'built-in'
  });
  return [
    rule({
      id: 'cpu_warm',
      metric: 'cpu_temperature',
      atLeast: 70,
      forMs: 10 * MIN,
      severity: 'warning',
      message: 'CPU running warm'
    }),
    rule({
      id: 'cpu_hot',
      metric: 'cpu_temperature',
      atLeast: 80,
      forMs: 2 * MIN,
      severity: 'critical',
      message: 'CPU running hot'
    }),
    rule({
      id: 'throttled_now',
      metric: 'throttled',
      bitsSet: 0xf,
      forMs: MIN,
      severity: 'critical',
      message: 'Throttling now'
    }),
    rule({
      id: 'throttled_before',
      metric: 'throttled',
      bitsSet: 0xf0000,
      forMs: 0,
      severity: 'warning',
      message: 'Throttled since boot'
    }),
    rule({
      id: 'disk_filling',
      metric: 'disk_used',
      atLeast: 70,
      forMs: 10 * MIN,
      severity: 'warning',
      message: 'Disk filling up'
    }),
    rule({
      id: 'disk_full',
      metric: 'disk_used',
      atLeast: 90,
      forMs: 10 * MIN,
      severity: 'critical',
      message: 'Disk almost full'
    }),
    rule({
      id: 'boot_filling',
      metric: 'boot_used',
      atLeast: 70,
      forMs: 10 * MIN,
      severity: 'warning',
      message: '/boot filling up'
    }),
    rule({
      id: 'boot_full',
      metric: 'boot_used',
      atLeast: 90,
      forMs: 10 * MIN,
      severity: 'critical',
      message: '/boot almost full'
    }),
    rule({
      id: 'load_queueing',
      metric: 'load_1',
      atLeast: cores,
      forMs: 15 * MIN,
      severity: 'warning',
      message: 'Work is queueing for the CPU or disk'
    }),
    rule({
      id: 'cpu_busy',
      metric: 'cpu_load',
      atLeast: 90,
      forMs: 15 * MIN,
      severity: 'warning',
      message: 'CPU busy for a long time'
    }),
    rule({
      id: 'swap_heavy',
      metric: 'swap_used',
      atLeast: 80,
      forMs: 10 * MIN,
      severity: 'warning',
      message: 'Swapping heavily'
    }),
    rule({
      id: 'swap_full',
      metric: 'swap_used',
      atLeast: 95,
      forMs: 10 * MIN,
      severity: 'critical',
      message: 'Swap nearly full'
    }),
    rule({
      id: 'not_collecting',
      metric: '*',
      noReadingFor: 'auto',
      forMs: 0,
      severity: 'warning',
      message: 'No new readings'
    })
  ];
}

/** Reads PIPULSE_ALERTS_FILE; a missing or unreadable file is an AlertRulesError. */
export function readRulesFile(path: string): RulesFile {
  try {
    return { name: path, text: readFileSync(path, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new AlertRulesError(`PIPULSE_ALERTS_FILE ${path} could not be read: ${code}`);
  }
}

const FIELDS = new Set([
  'id',
  'metric',
  'atLeast',
  'atMost',
  'bitsSet',
  'noReadingFor',
  'for',
  'clearAfter',
  'severity',
  'message',
  'disabled'
]);
const CONDITIONS = ['atLeast', 'atMost', 'bitsSet', 'noReadingFor'] as const;

type Entry = { id: string; disabled: true } | { id: string; disabled: false; rule: Rule };

function parseEntry(raw: unknown, where: string): Entry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AlertRulesError(`${where} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const label = typeof r['id'] === 'string' ? ` ("${r['id']}")` : '';
  const fail: (problem: string) => never = (problem) => {
    throw new AlertRulesError(`${where}${label}: ${problem}`);
  };
  for (const key of Object.keys(r)) if (!FIELDS.has(key)) fail(`unknown field "${key}"`);

  const id = r['id'];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id))
    fail('id must be lowercase snake_case');
  const ruleId = id as string;
  if (r['disabled'] !== undefined && typeof r['disabled'] !== 'boolean')
    fail('disabled must be true or false');
  if (r['disabled'] === true) return { id: ruleId, disabled: true };

  const duration = (field: string, allowZero: boolean): number | undefined => {
    const value = r[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') fail(`${field} must be a duration string like "5min"`);
    let ms = 0;
    try {
      ms = parseDuration(field, value as string, { allowZero });
    } catch (error) {
      fail((error as Error).message);
    }
    if (!Number.isFinite(ms)) fail(`${field} must not be forever`);
    return ms;
  };

  const present = CONDITIONS.filter((condition) => r[condition] !== undefined);
  if (present.length !== 1) {
    fail(`needs exactly one of ${CONDITIONS.join(', ')} (found ${present.length})`);
  }
  const condition = present[0]!;
  const metric = r['metric'];
  if (typeof metric !== 'string' || metric === '') fail('metric must be a plugin id');
  if (metric === '*' && condition !== 'noReadingFor')
    fail('metric "*" is only allowed with noReadingFor');
  const severity = r['severity'];
  if (severity !== 'warning' && severity !== 'critical')
    fail('severity must be warning or critical');
  const message = r['message'];
  if (typeof message !== 'string' || message.trim() === '') fail('message must be non-empty text');

  const rule: Rule = {
    id: ruleId,
    metric: metric as string,
    forMs: 0,
    clearAfterMs: 0,
    severity: severity as Severity,
    message: message as string,
    source: 'file'
  };
  if (condition === 'noReadingFor') {
    if (r['for'] !== undefined)
      fail('for is not allowed with noReadingFor (the limit is the duration)');
    if (r['clearAfter'] !== undefined)
      fail('clearAfter is not allowed with noReadingFor (a new reading ends the silence)');
    rule.noReadingFor = r['noReadingFor'] === 'auto' ? 'auto' : duration('noReadingFor', false)!;
  } else {
    const value = r[condition];
    if (condition === 'bitsSet') {
      if (!Number.isInteger(value) || (value as number) <= 0)
        fail('bitsSet must be a positive integer mask');
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`${condition} must be a number`);
    }
    rule[condition] = value as number;
    rule.forMs = duration('for', true) ?? 0;
    rule.clearAfterMs = duration('clearAfter', true) ?? rule.forMs;
  }
  return { id: ruleId, disabled: false, rule };
}

function parseFile({ name, text }: RulesFile): Entry[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AlertRulesError(`${name} is not valid JSON: ${(error as Error).message}`);
  }
  const list =
    typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as { rules?: unknown }).rules
      : undefined;
  if (!Array.isArray(list))
    throw new AlertRulesError(`${name} must be an object with a "rules" array`);
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const entry = parseEntry(raw, `${name} rules[${i}]`);
    if (seen.has(entry.id))
      throw new AlertRulesError(`${name}: rule id "${entry.id}" appears twice`);
    seen.add(entry.id);
    return entry;
  });
}

/**
 * The effective rules: built-ins, with the file's entries merged over them
 * by id (a new id adds, an existing one replaces, disabled removes). Throws
 * AlertRulesError on anything invalid, so a typo stops startup instead of
 * silently not alerting.
 */
export function resolveRules(options: {
  cores: number;
  metrics: MetricInfo[];
  rawRetentionMs: number;
  file?: RulesFile;
}): Rule[] {
  const rules = new Map(builtinRules(options.cores).map((rule) => [rule.id, rule]));
  if (options.file) {
    for (const entry of parseFile(options.file)) {
      if (entry.disabled) rules.delete(entry.id);
      else rules.set(entry.id, entry.rule);
    }
  }
  const known = options.metrics.map((metric) => metric.id);
  for (const rule of rules.values()) {
    const where = `alert rule "${rule.id}"`;
    if (rule.metric !== '*' && !known.includes(rule.metric)) {
      throw new AlertRulesError(
        `${where}: unknown metric "${rule.metric}" (known: ${known.join(', ')})`
      );
    }
    for (const [field, ms] of [
      ['for', rule.forMs],
      ['clearAfter', rule.clearAfterMs]
    ] as const) {
      if (ms > options.rawRetentionMs) {
        throw new AlertRulesError(
          `${where}: ${field} is longer than raw retention (PIPULSE_RETENTION_RAW); alerts only read raw readings`
        );
      }
    }
  }
  return [...rules.values()];
}
