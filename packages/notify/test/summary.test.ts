import { describe, expect, it } from 'vitest';
import type { WebhookConfig } from '../src/config.js';
import { renderSummary, summaryText, type SummaryInput } from '../src/summary.js';

const since = new Date(2026, 10, 16, 9, 0).getTime();
const now = new Date(2026, 10, 16, 11, 30).getTime();
const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  counts: [],
  open: [],
  since,
  now,
  ...over
});
const hook = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  id: 'w',
  url: 'http://x',
  method: 'POST',
  headers: {},
  events: ['raised', 'cleared'],
  minSeverity: 'warning',
  timeoutMs: 10_000,
  ...over
});
const context = { hostname: 'Io', metrics: [] };

describe('summaryText', () => {
  it('names rules and counts per kind, and what is still open', () => {
    const text = summaryText(
      input({
        counts: [
          { kind: 'opened_and_cleared', ruleId: 'cpu_busy', n: 2 },
          { kind: 'opened_and_cleared', ruleId: 'disk_full', n: 1 },
          { kind: 'abandoned', ruleId: 'cpu_busy', n: 2 },
          { kind: 'rejected', ruleId: 'cpu_busy', n: 1 },
          { kind: 'dropped', ruleId: 'disk_full', n: 4 }
        ],
        open: [{ ruleId: 'swap_full', metric: 'swap_used', severity: 'critical' }]
      }),
      { raised: true }
    );
    expect(text).toContain('3 alerts opened and cleared: cpu_busy ×2, disk_full ×1');
    expect(text).toContain('2 notifications could not be delivered');
    expect(text).toContain('1 notification was rejected by the endpoint');
    expect(text).toContain('4 notifications were dropped');
    expect(text).toContain('still open: swap_full (critical)');
  });

  it('leaves out what is still open when the webhook does not subscribe to raised', () => {
    const text = summaryText(
      input({
        counts: [{ kind: 'cleared', ruleId: 'cpu_busy', n: 1 }],
        open: [{ ruleId: 'swap_full', metric: 'swap_used', severity: 'warning' }]
      }),
      { raised: false }
    );
    expect(text).toContain('1 alert cleared: cpu_busy ×1');
    expect(text).not.toContain('still open');
  });

  it('lists at most ten rules, then says how many more', () => {
    const counts = Array.from({ length: 25 }, (_, i) => ({
      kind: 'opened_and_cleared' as const,
      ruleId: `rule_${String(i).padStart(2, '0')}`,
      n: 1
    }));
    const text = summaryText(input({ counts }), { raised: true });
    expect(text).toContain('25 alerts opened and cleared');
    expect(text).toContain('rule_09 ×1');
    expect(text).not.toContain('rule_10');
    expect(text).toContain('and 15 more');
  });

  it('stays within 1000 characters however long the rule ids and lists are', () => {
    const counts = Array.from({ length: 60 }, (_, i) => ({
      kind: 'opened_and_cleared' as const,
      ruleId: `${i}-${'x'.repeat(200)}`,
      n: 1
    }));
    const open = Array.from({ length: 60 }, (_, i) => ({
      ruleId: `${i}-${'y'.repeat(200)}`,
      metric: 'm',
      severity: 'warning' as const
    }));
    expect(summaryText(input({ counts, open }), { raised: true }).length).toBeLessThanOrEqual(1000);
  });

  it('says so when there is nothing to report but the delay', () => {
    expect(summaryText(input(), { raised: true })).toBe('Notifications were delayed.');
  });
});

describe('renderSummary', () => {
  const counts = [{ kind: 'opened_and_cleared' as const, ruleId: 'cpu_busy', n: 1 }];

  it('gives a webhook without a body the Apprise shape, failure when a critical alert is open', () => {
    const open = [{ ruleId: 'swap_full', metric: 'swap_used', severity: 'critical' as const }];
    expect(JSON.parse(renderSummary(hook(), input({ counts, open }), context))).toEqual({
      title: 'Io: notifications were delayed',
      body: summaryText(input({ counts, open }), { raised: true }),
      type: 'failure'
    });
    expect(JSON.parse(renderSummary(hook(), input({ counts }), context)).type).toBe('warning');
  });

  it("renders a custom body with the summary's own placeholders", () => {
    const body = {
      event: '{{event}}',
      text: '{{hostname}}: {{message}}',
      sev: '{{severity}}',
      from: '{{raisedAt}}',
      to: '{{clearedAt}}',
      rule: '{{ruleId}}',
      value: '{{value}}',
      duration: '{{duration}}',
      by: '{{clearedBy}}'
    };
    const open = [{ ruleId: 'swap_full', metric: 'swap_used', severity: 'critical' as const }];
    const parsed = JSON.parse(renderSummary(hook({ body }), input({ counts, open }), context));
    expect(parsed).toMatchObject({
      event: 'summary',
      sev: 'critical',
      rule: '',
      value: null,
      duration: null,
      by: null
    });
    expect(parsed.text).toBe(`Io: ${summaryText(input({ counts, open }), { raised: true })}`);
    expect(parsed.from).toMatch(/2026/);
    expect(parsed.to).not.toBe(parsed.from);
  });

  it('prefers summaryBody over body', () => {
    const rendered = renderSummary(
      hook({
        body: { a: '{{message}}' },
        summaryBody: { delayed: '{{message}}', host: '{{hostname}}' }
      }),
      input({ counts }),
      context
    );
    expect(Object.keys(JSON.parse(rendered))).toEqual(['delayed', 'host']);
  });

  it('only lists what is open for a webhook that subscribes to raised', () => {
    const open = [{ ruleId: 'swap_full', metric: 'swap_used', severity: 'warning' as const }];
    const text = JSON.parse(
      renderSummary(hook({ events: ['cleared'] }), input({ counts, open }), context)
    ).body;
    expect(text).not.toContain('still open');
  });
});
