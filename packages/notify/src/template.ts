import type { Alert } from '@pipulse/alerts';

export const PLACEHOLDERS = [
  'event',
  'ruleId',
  'metric',
  'metricLabel',
  'severity',
  'message',
  'value',
  'rawValue',
  'raisedAt',
  'clearedAt',
  'duration',
  'clearedBy',
  'hostname'
] as const;

export type Fields = Record<string, string | number | null>;
export interface MetricLabel {
  id: string;
  label: string;
  unit: string;
}

/** A template problem; its message names the placeholder. */
export class TemplateError extends Error {}

const TOKEN = /\{\{(\w+)\}\}/g;
const LONE = /^\{\{(\w+)\}\}$/;

/** Every string inside a JSON value, depth first. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) yield* strings(item);
}

export function checkTemplate(template: unknown): void {
  for (const text of strings(template)) {
    for (const [, name] of text.matchAll(TOKEN)) {
      if (!(PLACEHOLDERS as readonly string[]).includes(name!)) {
        throw new TemplateError(
          `unknown placeholder {{${name}}} (known: ${PLACEHOLDERS.join(', ')})`
        );
      }
    }
  }
}

/**
 * Replaces placeholders inside string values only, in one pass, so braces in a
 * field's value are never expanded again. A string that is exactly one
 * placeholder takes the field's JSON type.
 */
export function renderTemplate(template: unknown, fields: Fields): unknown {
  if (typeof template === 'string') {
    const lone = LONE.exec(template);
    if (lone) return fields[lone[1]!] ?? null;
    return template.replace(TOKEN, (_, name: string) => String(fields[name] ?? ''));
  }
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, fields));
  if (template !== null && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template).map(([key, item]) => [key, renderTemplate(item, fields)])
    );
  }
  return template;
}

/** "YYYY-MM-DD HH:MM" in the server's local time zone. */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Largest whole unit ("45 s" | "12 min" | "3 h" | "2 d"), rounded down. */
export function formatDuration(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)} d`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)} h`;
  if (ms >= MINUTE) return `${Math.floor(ms / MINUTE)} min`;
  return `${Math.floor(ms / SECOND)} s`;
}

export function formatValue(value: number, unit: string): string {
  const text = unit === 'flags' ? `0x${value.toString(16)}` : String(Number(value.toFixed(1)));
  return unit && unit !== 'flags' ? `${text} ${unit}` : text;
}

export function fieldsFor(
  event: 'raised' | 'cleared' | 'test',
  alert: Alert,
  context: { hostname: string; metrics: MetricLabel[] }
): Fields {
  const metric = context.metrics.find((m) => m.id === alert.metric);
  const metricLabel = metric?.label ?? alert.metric;
  const unit = metric?.unit ?? '';
  const hasCleared = alert.clearedAt !== null;
  return {
    event,
    ruleId: alert.ruleId,
    metric: alert.metric,
    metricLabel,
    severity: alert.severity,
    message: alert.message,
    value: alert.value === null ? null : formatValue(alert.value, unit),
    rawValue: alert.value,
    raisedAt: formatLocalTime(alert.raisedAt),
    clearedAt: hasCleared ? formatLocalTime(alert.clearedAt!) : null,
    duration: hasCleared ? formatDuration(alert.clearedAt! - alert.raisedAt) : null,
    clearedBy: hasCleared ? alert.clearedBy : null,
    hostname: context.hostname
  };
}

/** The Apprise-shaped default body: a title, a body line, and a type per event/severity. */
export function defaultBody(
  event: 'raised' | 'cleared' | 'test',
  severity: 'warning' | 'critical'
): unknown {
  const type =
    event === 'test'
      ? 'info'
      : event === 'cleared'
        ? 'success'
        : severity === 'critical'
          ? 'failure'
          : 'warning';
  return {
    title: '{{hostname}}: {{message}}',
    // An alert keeps only the reading that raised it: on a clear, say so, or
    // "CPU load 27.5 % (cleared)" reads as the load now.
    body:
      event === 'cleared'
        ? '{{metricLabel}} {{value}} when raised, cleared after {{duration}} ({{severity}})'
        : '{{metricLabel}} {{value}} ({{severity}}, {{event}})',
    type
  };
}

export function renderPayload(
  body: unknown | undefined,
  event: 'raised' | 'cleared' | 'test',
  alert: Alert,
  context: { hostname: string; metrics: MetricLabel[] }
): string {
  return JSON.stringify(
    renderTemplate(body ?? defaultBody(event, alert.severity), fieldsFor(event, alert, context))
  );
}
