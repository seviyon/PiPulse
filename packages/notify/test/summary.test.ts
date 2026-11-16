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

describe('summaryText, wording and limits', () => {
  const alone = (kind: SummaryInput['counts'][number]['kind'], n: number) =>
    summaryText(input({ counts: [{ kind, ruleId: 'r', n }] }), { raised: true });

  it('says one and many for each kind', () => {
    expect(alone('opened_and_cleared', 1)).toBe('1 alert opened and cleared: r ×1');
    expect(alone('opened_and_cleared', 2)).toBe('2 alerts opened and cleared: r ×2');
    expect(alone('cleared', 1)).toBe('1 alert cleared: r ×1');
    expect(alone('cleared', 2)).toBe('2 alerts cleared: r ×2');
    expect(alone('abandoned', 1)).toBe('1 notification could not be delivered');
    expect(alone('abandoned', 2)).toBe('2 notifications could not be delivered');
    expect(alone('rejected', 1)).toBe('1 notification was rejected by the endpoint');
    expect(alone('rejected', 2)).toBe('2 notifications were rejected by the endpoint');
    expect(alone('dropped', 1)).toBe('1 notification was dropped');
    expect(alone('dropped', 2)).toBe('2 notifications were dropped');
  });

  it('puts each kind on its own line', () => {
    const text = summaryText(
      input({
        counts: [
          { kind: 'opened_and_cleared', ruleId: 'a', n: 1 },
          { kind: 'dropped', ruleId: 'a', n: 1 }
        ],
        open: [{ ruleId: 'b', metric: 'm', severity: 'warning' }]
      }),
      { raised: true }
    );
    expect(text.split('\n')).toEqual([
      '1 alert opened and cleared: a ×1',
      '1 notification was dropped',
      'still open: b (warning)'
    ]);
  });

  it('orders rules by count, then by name, and shortens only ids longer than 40 characters', () => {
    const counts = [
      { kind: 'opened_and_cleared' as const, ruleId: 'b', n: 1 },
      { kind: 'opened_and_cleared' as const, ruleId: 'a', n: 3 },
      { kind: 'opened_and_cleared' as const, ruleId: 'c', n: 1 },
      { kind: 'opened_and_cleared' as const, ruleId: 'x'.repeat(40), n: 1 },
      { kind: 'opened_and_cleared' as const, ruleId: 'y'.repeat(41), n: 1 }
    ];
    expect(summaryText(input({ counts }), { raised: true })).toBe(
      `7 alerts opened and cleared: a ×3, b ×1, c ×1, ${'x'.repeat(40)} ×1, ${'y'.repeat(39)}… ×1`
    );
  });

  it('breaks ties between equal counts by name, whatever order the rules arrive in', () => {
    const counts = ['c', 'b', 'a'].map((ruleId) => ({
      kind: 'opened_and_cleared' as const,
      ruleId,
      n: 1
    }));
    expect(summaryText(input({ counts }), { raised: true })).toBe(
      '3 alerts opened and cleared: a ×1, b ×1, c ×1'
    );
  });

  it('adds "and N more" only past ten rules', () => {
    const rules = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: 'opened_and_cleared' as const,
        ruleId: `r${String(i).padStart(2, '0')}`,
        n: 1
      }));
    expect(summaryText(input({ counts: rules(10) }), { raised: true })).not.toContain('more');
    const eleven = summaryText(input({ counts: rules(11) }), { raised: true });
    expect(eleven).toContain('r08 ×1, r09 ×1, and 1 more');
    expect(eleven).not.toContain('r10');
  });

  it('lists at most ten open alerts, then says how many more, and none for a single one', () => {
    const open = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ruleId: `o${String(i).padStart(2, '0')}`,
        metric: 'm',
        severity: 'warning' as const
      }));
    const ten = summaryText(input({ open: open(10) }), { raised: true });
    expect(ten).not.toContain('more');
    expect(ten.split(', ')).toHaveLength(10);
    const twelve = summaryText(input({ open: open(12) }), { raised: true });
    expect(twelve).toContain('o09 (warning), and 2 more');
    expect(twelve).not.toContain('o10');
    expect(summaryText(input({ open: open(1) }), { raised: true })).toBe(
      'still open: o00 (warning)'
    );
  });

  it('keeps a text of exactly 1000 characters whole and cuts one more to 1000 with an ellipsis', () => {
    const build = (idLength: number, clearedRules: number, openCount: number, extra = 0) =>
      summaryText(
        input({
          counts: Array.from({ length: 10 }, (_, i) => ({
            kind: 'opened_and_cleared' as const,
            ruleId: `${i}${'k'.repeat(idLength - 1)}`,
            n: 1
          }))
            .concat(
              Array.from({ length: clearedRules }, (_, i) => ({
                kind: 'cleared' as const,
                ruleId: `${i}${'k'.repeat(39)}`,
                n: 1
              }))
            )
            .concat(
              // Lines with a fixed wording and a count of one digit, or two: a finer step.
              [
                { kind: 'abandoned' as const, ruleId: 'x', n: extra & 1 ? 10 : extra & 2 ? 1 : 0 },
                { kind: 'dropped' as const, ruleId: 'x', n: extra & 4 ? 10 : extra & 8 ? 1 : 0 },
                { kind: 'rejected' as const, ruleId: 'x', n: extra & 16 ? 1 : 0 }
              ].filter((c) => c.n > 0)
            ),
          open: Array.from({ length: openCount }, (_, i) => ({
            ruleId: `${i}${'k'.repeat(idLength - 1)}`,
            metric: 'm',
            severity: 'warning' as const
          }))
        }),
        { raised: true }
      );
    let found: [number, number, number, number] | undefined;
    for (let id = 1; id <= 39 && !found; id++)
      for (let cleared = 0; cleared <= 10 && !found; cleared++)
        for (let open = 0; open <= 10 && !found; open++)
          for (let extra = 0; extra < 32 && !found; extra++) {
            const text = build(id, cleared, open, extra);
            if (text.length === 1000 && !text.endsWith('…')) found = [id, cleared, open, extra];
          }
    expect(found, 'a combination that gives exactly 1000 characters').toBeDefined();
    const [id, cleared, open, extra] = found!;
    const whole = build(id, cleared, open, extra);
    expect(whole).toHaveLength(1000);
    expect(whole).not.toContain('…');
    const longer = build(id + 1, cleared, open, extra);
    expect(longer).toHaveLength(1000);
    expect(longer.endsWith('…')).toBe(true);
  });
});

describe('renderSummary, severity', () => {
  const counts = [{ kind: 'opened_and_cleared' as const, ruleId: 'r', n: 1 }];
  const open = (severity: 'warning' | 'critical') => [{ ruleId: 'o', metric: 'm', severity }];

  it('is warning when only warnings are open, critical when any critical is', () => {
    const body = { sev: '{{severity}}' };
    const sev = (w: WebhookConfig, openAlerts: SummaryInput['open']) =>
      JSON.parse(renderSummary(w, input({ counts, open: openAlerts }), context));
    expect(sev(hook({ body }), open('warning')).sev).toBe('warning');
    expect(sev(hook({ body }), open('critical')).sev).toBe('critical');
    expect(sev(hook(), open('warning')).type).toBe('warning');
    expect(sev(hook(), open('critical')).type).toBe('failure');
    expect(
      sev(hook({ body, events: ['cleared'] }), open('critical')).sev // not told about raises: not critical
    ).toBe('warning');
  });
});
