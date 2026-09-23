import type { Rule } from './rules.js';

/** What the store reports about one metric's raw readings in a window. */
export interface WindowSummary {
  count: number;
  oldest: number | null;
  newest: number | null;
  min: number | null;
  max: number | null;
  /** Readings with any of the rule's bitsSet bits (0 when it has none). */
  withBits: number;
  /** Longest time between consecutive readings; null with fewer than two. */
  maxGap: number | null;
}

export interface Reading {
  ts: number;
  value: number;
}

export interface CheckInput {
  now: number;
  /** Engine start, or its last clock jump: silence is never counted from before it. */
  since: number;
  intervalMs: number;
  /** Whether this rule already has an open alert for this metric. */
  open: boolean;
  /** The metric's newest stored reading, if it has one. */
  latest: Reading | null;
  /** Readings in [now - windowMs(rule, open), now]; ignored for silence rules and zero windows. */
  window: WindowSummary;
}

export type Decision =
  { action: 'raise'; value: number | null } | { action: 'clear' } | { action: 'none' };

export const EMPTY_WINDOW: WindowSummary = {
  count: 0,
  oldest: null,
  newest: null,
  min: null,
  max: null,
  withBits: 0,
  maxGap: null
};

const MIN = 60_000;
const NONE: Decision = { action: 'none' };
const CLEAR: Decision = { action: 'clear' };

export function silenceLimitMs(rule: Rule, intervalMs: number): number {
  return rule.noReadingFor === 'auto'
    ? Math.max(5 * intervalMs, 2 * MIN)
    : (rule.noReadingFor ?? 0);
}

/** How far back a check looks: `for` while no alert is open, `clearAfter` while one is. */
export function windowMs(rule: Rule, open: boolean): number {
  return open ? rule.clearAfterMs : rule.forMs;
}

/**
 * Readings span the window: from within two polls of its start to within two
 * polls of now, missing no more than two polls in a row anywhere between.
 */
function covered(w: WindowSummary, now: number, span: number, intervalMs: number): boolean {
  const slack = 2 * intervalMs;
  return (
    w.count > 0 &&
    w.oldest !== null &&
    w.newest !== null &&
    w.oldest <= now - span + slack &&
    w.newest >= now - slack &&
    (w.maxGap ?? 0) <= 3 * intervalMs
  );
}

function holds(rule: Rule, value: number): boolean {
  if (rule.atLeast !== undefined) return value >= rule.atLeast;
  if (rule.atMost !== undefined) return value <= rule.atMost;
  if (rule.bitsSet !== undefined) return (value & rule.bitsSet) !== 0;
  return false;
}

/**
 * Raise, clear or leave a rule's alert for one metric. Both directions need
 * evidence: a window not covered by readings decides nothing, so a server
 * that just started can't claim "hot for 10 minutes" and a gap in
 * collection never clears an alert. Hysteresis comes from the two windows.
 */
export function evaluate(rule: Rule, input: CheckInput): Decision {
  const { now, open, latest, intervalMs } = input;

  if (rule.noReadingFor !== undefined) {
    if (latest === null) return NONE;
    const limit = silenceLimitMs(rule, intervalMs);
    if (!open)
      return now - Math.max(latest.ts, input.since) > limit
        ? { action: 'raise', value: null }
        : NONE;
    return now - latest.ts <= limit ? CLEAR : NONE;
  }

  const span = windowMs(rule, open);
  if (span === 0) {
    if (latest === null || latest.ts < now - 2 * intervalMs) return NONE;
    const breached = holds(rule, latest.value);
    if (!open) return breached ? { action: 'raise', value: latest.value } : NONE;
    return breached ? NONE : CLEAR;
  }

  const w = input.window;
  if (!covered(w, now, span, intervalMs)) return NONE;
  if (!open) {
    const always =
      rule.atLeast !== undefined
        ? w.min! >= rule.atLeast
        : rule.atMost !== undefined
          ? w.max! <= rule.atMost
          : w.withBits === w.count;
    return always ? { action: 'raise', value: latest?.value ?? null } : NONE;
  }
  const never =
    rule.atLeast !== undefined
      ? w.max! < rule.atLeast
      : rule.atMost !== undefined
        ? w.min! > rule.atMost
        : w.withBits === 0;
  return never ? CLEAR : NONE;
}
