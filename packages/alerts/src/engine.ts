import type { PiPulseDb } from '@pipulse/storage';
import { EMPTY_WINDOW, evaluate, windowMs } from './evaluate.js';
import type { MetricInfo, Rule } from './rules.js';
import {
  clearAlert,
  latestReading,
  openAlerts,
  raiseAlert,
  summarizeWindow,
  type Alert
} from './store.js';

export interface AlertEvent {
  type: 'raised' | 'cleared';
  alert: Alert;
}

export const CHECK_INTERVAL_MS = 15_000;

const key = (ruleId: string, metric: string) => `${ruleId}\u0000${metric}`;

/**
 * Checks every rule against every metric it watches now and then every
 * `intervalMs`. Alert rows are the only state, so a restart resumes where
 * the last run stopped. At start, alerts whose rule (or rule and metric)
 * no longer exists are closed as "rule_removed". A failing rule is
 * reported and the rest still run; a throwing listener never stops checks.
 * If reading the open alerts fails (a transient SQLite error, disk error, etc.),
 * the error is reported via `onError` with no rule, and the next check still runs.
 */
export function startAlerts(
  db: PiPulseDb,
  options: {
    rules: Rule[];
    metrics: MetricInfo[];
    intervalMs?: number;
    now?: () => number;
    onChange?: (event: AlertEvent) => void;
    onError?: (error: unknown, rule?: Rule) => void;
  }
): { check(): void; stop(): void } {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const byId = new Map(options.metrics.map((metric) => [metric.id, metric]));
  const targets = (rule: Rule): MetricInfo[] =>
    rule.metric === '*' ? options.metrics : [byId.get(rule.metric)].filter((m) => m !== undefined);
  const emit = (event: AlertEvent) => {
    try {
      options.onChange?.(event);
    } catch {
      // A broken listener (e.g. a socket mid-close) must not stop the checks.
    }
  };

  const watched = new Set(
    options.rules.flatMap((rule) => targets(rule).map((m) => key(rule.id, m.id)))
  );
  for (const alert of openAlerts(db)) {
    if (!watched.has(key(alert.ruleId, alert.metric))) {
      emit({ type: 'cleared', alert: clearAlert(db, alert.id, now(), 'rule_removed') });
    }
  }

  let since = now();
  let lastCheck: number | undefined;

  const check = () => {
    try {
      const t = now();
      // The Pi has no RTC: NTP can move the clock hours at once after boot,
      // and a long pause looks the same. Count silence afresh from here.
      if (lastCheck !== undefined && (t < lastCheck || t - lastCheck > 3 * intervalMs)) since = t;
      lastCheck = t;
      const open = new Map(openAlerts(db).map((alert) => [key(alert.ruleId, alert.metric), alert]));
      for (const rule of options.rules) {
        for (const metric of targets(rule)) {
          try {
            const current = open.get(key(rule.id, metric.id));
            const span = windowMs(rule, current !== undefined);
            const decision = evaluate(rule, {
              now: t,
              since,
              intervalMs: metric.intervalMs,
              open: current !== undefined,
              latest: latestReading(db, metric.id),
              window:
                span > 0 && rule.noReadingFor === undefined
                  ? summarizeWindow(db, metric.id, t - span, t, rule.bitsSet ?? 0)
                  : EMPTY_WINDOW
            });
            if (decision.action === 'raise' && current === undefined) {
              emit({
                type: 'raised',
                alert: raiseAlert(db, {
                  ruleId: rule.id,
                  metric: metric.id,
                  severity: rule.severity,
                  message: rule.message,
                  value: decision.value,
                  raisedAt: t
                })
              });
            } else if (decision.action === 'clear' && current !== undefined) {
              emit({ type: 'cleared', alert: clearAlert(db, current.id, t, 'condition') });
            }
          } catch (error) {
            options.onError?.(error, rule);
          }
        }
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  check();
  const timer = setInterval(check, intervalMs);
  return { check, stop: () => clearInterval(timer) };
}
