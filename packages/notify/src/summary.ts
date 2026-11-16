import type { WebhookConfig } from './config.js';
import type { CountKind } from './state.js';
import { fieldsForSummary, renderTemplate, type MetricLabel } from './template.js';

export interface SummaryInput {
  /** Per-rule counts compaction and failures collected since the last summary. */
  counts: { kind: CountKind; ruleId: string; n: number }[];
  /** Alerts open now (already filtered to this webhook's severity). */
  open: { ruleId: string; metric: string; severity: 'warning' | 'critical' }[];
  /** The outage window: when delivery went wrong, and now. */
  since: number;
  now: number;
}

const MAX_RULES = 10;
const MAX_ID = 40;
const MAX_TEXT = 1000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const shorten = (text: string) => (text.length > MAX_ID ? `${text.slice(0, MAX_ID - 1)}…` : text);

/** "a ×2, b ×1, and 15 more": at most ten rules, biggest counts first. */
function ruleList(counts: { ruleId: string; n: number }[]): string {
  const byRule = new Map<string, number>();
  for (const { ruleId, n } of counts) byRule.set(ruleId, (byRule.get(ruleId) ?? 0) + n);
  const sorted = [...byRule].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, MAX_RULES).map(([id, n]) => `${shorten(id)} ×${n}`);
  const more = sorted.length - shown.length;
  return more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ');
}

/**
 * What the recovery summary says: what opened and cleared while delivery was unavailable,
 * what could not be delivered, and (if the webhook gets raises) what is open now. One
 * line each, at most about 1 KB in all.
 */
export function summaryText(input: SummaryInput, wants: { raised: boolean }): string {
  const lines: string[] = [];
  const of = (kind: CountKind) => input.counts.filter((c) => c.kind === kind);
  const total = (kind: CountKind) => of(kind).reduce((sum, c) => sum + c.n, 0);

  const opened = total('opened_and_cleared');
  if (opened > 0)
    lines.push(
      `${plural(opened, 'alert', 'alerts')} opened and cleared: ${ruleList(of('opened_and_cleared'))}`
    );
  const cleared = total('cleared');
  if (cleared > 0)
    lines.push(`${plural(cleared, 'alert', 'alerts')} cleared: ${ruleList(of('cleared'))}`);
  const abandoned = total('abandoned');
  if (abandoned > 0)
    lines.push(`${plural(abandoned, 'notification', 'notifications')} could not be delivered`);
  const rejected = total('rejected');
  if (rejected > 0)
    lines.push(
      rejected === 1
        ? '1 notification was rejected by the endpoint'
        : `${rejected} notifications were rejected by the endpoint`
    );
  const dropped = total('dropped');
  if (dropped > 0)
    lines.push(
      dropped === 1 ? '1 notification was dropped' : `${dropped} notifications were dropped`
    );
  if (wants.raised && input.open.length > 0) {
    const shown = input.open.slice(0, MAX_RULES).map((a) => `${shorten(a.ruleId)} (${a.severity})`);
    const more = input.open.length - shown.length;
    lines.push(`still open: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`);
  }
  if (lines.length === 0) return 'Notifications were delayed.';
  const text = lines.join('\n');
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

/**
 * The summary as the webhook's payload. No body: the Apprise shape. A custom `body` (or
 * `summaryBody`, which wins) is rendered with event "summary", the summary text as
 * `message`, and the alert-specific placeholders empty.
 */
export function renderSummary(
  webhook: WebhookConfig,
  input: SummaryInput,
  context: { hostname: string; metrics: MetricLabel[] }
): string {
  const wantsRaised = webhook.events.includes('raised');
  const text = summaryText(input, { raised: wantsRaised });
  const critical = wantsRaised && input.open.some((a) => a.severity === 'critical');
  const severity = critical ? 'critical' : 'warning';
  const template = webhook.summaryBody ?? webhook.body;
  if (template === undefined) {
    return JSON.stringify({
      title: `${context.hostname}: notifications were delayed`,
      body: text,
      type: critical ? 'failure' : 'warning'
    });
  }
  return JSON.stringify(
    renderTemplate(
      template,
      fieldsForSummary(text, severity, input.since, input.now, context.hostname)
    )
  );
}
