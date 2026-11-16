import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { clearAlert, raiseAlert } from '@pipulse/alerts';
import type { WebhookConfig } from '../src/config.js';
import { ELIGIBLE_AFTER_MS, PENDING_CAP, compact } from '../src/compact.js';
import { insertNotification, markFailed, markSent, markStarted } from '../src/outbox.js';
import {
  addCount,
  clearNeedsAttention,
  getState,
  hasUnsummarized,
  setDegraded,
  setNeedsAttention
} from '../src/state.js';

const MIN = 60_000;
const NOW = 100_000_000_000;
let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const hook = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  id: 'w',
  url: 'http://x',
  method: 'POST',
  headers: {},
  events: ['raised', 'cleared'],
  minSeverity: 'warning',
  timeoutMs: 1000,
  ...over
});
const context = { now: NOW, hostname: 'Io', metrics: [] };
const run = (webhook = hook(), now = NOW) => compact(db, webhook, { ...context, now });

let n = 0;
/** An alert (cleared when `clearedAgo` is given) and the rows a webhook would have queued for it. */
function episode(
  opts: {
    webhook?: string;
    rule?: string;
    severity?: 'warning' | 'critical';
    raisedAgo?: number;
    clearedAgo?: number | null;
    raise?: boolean;
    clear?: boolean;
  } = {}
) {
  const webhook = opts.webhook ?? 'w';
  const rule = opts.rule ?? `rule_${n++}`;
  const raisedAt = NOW - (opts.raisedAgo ?? 10 * MIN);
  const alert = raiseAlert(db, {
    ruleId: rule,
    metric: `m_${rule}`,
    severity: opts.severity ?? 'warning',
    message: rule,
    value: 1,
    raisedAt
  });
  const cleared = opts.clearedAgo !== undefined && opts.clearedAgo !== null;
  if (cleared) clearAlert(db, alert.id, NOW - opts.clearedAgo!, 'condition');
  const add = (event: 'raised' | 'cleared', at: number) =>
    insertNotification(db, {
      webhookId: webhook,
      alertId: alert.id,
      event,
      ruleId: rule,
      metric: alert.metric,
      payload: '{}',
      nextAt: at,
      createdAt: at
    });
  if (opts.raise !== false) add('raised', raisedAt);
  if (cleared && opts.clear !== false) add('cleared', NOW - opts.clearedAgo!);
  return { alert, rule };
}
const rowsOf = (webhook = 'w') =>
  db
    .prepare(
      `SELECT id, event, status, alert_id AS alertId, rule_id AS ruleId, started_at AS startedAt FROM notifications WHERE webhook_id = ? AND event <> 'summary' ORDER BY id`
    )
    .all(webhook) as {
    id: number;
    event: string;
    status: string;
    alertId: number;
    ruleId: string;
    startedAt: number | null;
  }[];
const events = (webhook = 'w') => rowsOf(webhook).map((r) => r.event);
const summaries = (webhook = 'w') =>
  db
    .prepare(
      "SELECT id, payload, status, started_at AS startedAt FROM notifications WHERE webhook_id = ? AND event = 'summary'"
    )
    .all(webhook) as { id: number; payload: string; status: string; startedAt: number | null }[];
const rowFor = (alertId: number, event: string) =>
  rowsOf().find((r) => r.alertId === alertId && r.event === event)!;

describe('constants', () => {
  it('uses the spec values', () => {
    expect(ELIGIBLE_AFTER_MS).toBe(5 * MIN);
    expect(PENDING_CAP).toBe(100);
  });
});

describe('coalescing never-started rows', () => {
  it('drops a raise and its clear for an alert that opened and cleared, and queues one summary', () => {
    const a = episode({ rule: 'cpu_busy', raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    const open = episode({ rule: 'swap_full', severity: 'critical' });
    const result = run();
    expect(result).toEqual({ coalesced: 2, summaryQueued: true });
    expect(rowsOf().filter((r) => r.alertId === a.alert.id)).toEqual([]);
    expect(rowFor(open.alert.id, 'raised')).toBeDefined();
    const [summary] = summaries();
    expect(JSON.parse(summary!.payload).body).toContain('1 alert opened and cleared: cpu_busy ×1');
    expect(JSON.parse(summary!.payload).body).toContain('still open: swap_full (critical)');
    expect(getState(db, 'w').counts.opened_and_cleared).toBe(1);
    expect(hasUnsummarized(db, 'w')).toBe(false);
    expect(getState(db, 'w').lastSummaryAt).toBe(NOW);
  });

  it('keeps rows younger than 5 minutes', () => {
    episode({ raisedAgo: 4 * MIN, clearedAgo: 1 * MIN });
    expect(run()).toEqual({ coalesced: 0, summaryQueued: false });
    expect(events()).toEqual(['raised', 'cleared']);
  });

  it('ignores the age protection above the cap, and counts those rows as dropped', () => {
    for (let i = 0; i < 51; i++) episode({ raisedAgo: 3 * MIN, clearedAgo: 1 * MIN });
    expect(rowsOf()).toHaveLength(102);
    expect(run().coalesced).toBe(102);
    expect(getState(db, 'w').counts).toMatchObject({ dropped: 51, opened_and_cleared: 0 });
    expect(JSON.parse(summaries()[0]!.payload).body).toContain('51 notifications were dropped');
  });

  it('keeps the raise of an alert that is still open', () => {
    const open = episode({ raisedAgo: 30 * MIN });
    expect(run()).toEqual({ coalesced: 0, summaryQueued: false });
    expect(rowFor(open.alert.id, 'raised')).toBeDefined();
  });

  it('treats an alert missing from the alerts table as cleared, without throwing', () => {
    const a = episode({ raisedAgo: 20 * MIN });
    db.prepare('DELETE FROM alerts WHERE id = ?').run(a.alert.id);
    expect(() => run()).not.toThrow();
    expect(rowsOf()).toEqual([]);
    expect(getState(db, 'w').counts.opened_and_cleared).toBe(1);
  });

  it('never touches another webhook', () => {
    episode({ webhook: 'other', raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    episode({ raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    run();
    expect(events('other')).toEqual(['raised', 'cleared']);
    expect(summaries('other')).toEqual([]);
  });
});

describe('rows that may have reached the receiver', () => {
  it('never coalesces a started raise, and keeps its clear', () => {
    const a = episode({ raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    markStarted(db, rowFor(a.alert.id, 'raised').id, NOW - 15 * MIN);
    expect(run()).toEqual({ coalesced: 0, summaryQueued: false });
    expect(events()).toEqual(['raised', 'cleared']);
  });

  it('keeps a clear whose raise was sent', () => {
    const a = episode({ raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    const raise = rowFor(a.alert.id, 'raised');
    markStarted(db, raise.id, NOW - 19 * MIN);
    markSent(db, raise.id, NOW - 19 * MIN);
    expect(run().coalesced).toBe(0);
    expect(
      rowsOf()
        .filter((r) => r.status === 'pending')
        .map((r) => r.event)
    ).toEqual(['cleared']);
  });

  it('keeps a clear whose raise was rejected or abandoned', () => {
    const a = episode({ raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    const b = episode({ raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    for (const [alert, kind] of [
      [a, 'rejected'],
      [b, 'abandoned']
    ] as const) {
      const raise = rowFor(alert.alert.id, 'raised');
      markStarted(db, raise.id, NOW - 19 * MIN);
      markFailed(db, raise.id, NOW - 18 * MIN, 'x', kind);
    }
    expect(run().coalesced).toBe(0);
    expect(
      rowsOf()
        .filter((r) => r.status === 'pending')
        .map((r) => r.event)
    ).toEqual(['cleared', 'cleared']);
  });

  it('keeps a pending clear when its raise row no longer exists (pruned long ago)', () => {
    episode({ raisedAgo: 20 * MIN, clearedAgo: 10 * MIN, raise: false });
    expect(run().coalesced).toBe(0);
    expect(events()).toEqual(['cleared']);
  });

  it('keeps both rows when the clear was started even though the raise was not', () => {
    const a = episode({ raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    markStarted(db, rowFor(a.alert.id, 'cleared').id, NOW - 5 * MIN);
    expect(run().coalesced).toBe(0);
    expect(events()).toEqual(['raised', 'cleared']);
  });
});

describe('subscription shapes', () => {
  it('summarizes and deletes eligible clears for a cleared-only webhook, keeps young ones', () => {
    const hooked = hook({ events: ['cleared'] });
    episode({ rule: 'cpu_busy', raisedAgo: 30 * MIN, clearedAgo: 20 * MIN, raise: false });
    episode({ raisedAgo: 4 * MIN, clearedAgo: 2 * MIN, raise: false });
    expect(run(hooked).coalesced).toBe(1);
    expect(events()).toEqual(['cleared']);
    expect(getState(db, 'w').counts).toMatchObject({ cleared: 1, opened_and_cleared: 0 });
    const body = JSON.parse(summaries()[0]!.payload).body as string;
    expect(body).toContain('1 alert cleared: cpu_busy ×1');
    expect(body).not.toContain('still open');
  });

  it('drops an unsent raise of a now-cleared alert for a raised-only webhook', () => {
    const hooked = hook({ events: ['raised'] });
    episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN, clear: false });
    expect(run(hooked).coalesced).toBe(1);
    expect(events()).toEqual([]);
    expect(getState(db, 'w').counts.opened_and_cleared).toBe(1);
  });
});

describe('the summary row', () => {
  it('lists what is open from the alerts table, filtered by minSeverity', () => {
    episode({ rule: 'gone', raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    episode({ rule: 'minor', severity: 'warning', raisedAgo: 3 * MIN, clear: false });
    episode({ rule: 'major', severity: 'critical', raisedAgo: 3 * MIN });
    run(hook({ minSeverity: 'critical' }));
    const body = JSON.parse(summaries()[0]!.payload).body as string;
    expect(body).toContain('still open: major (critical)');
    expect(body).not.toContain('minor');
  });

  it('merges into an unstarted pending summary, adding the counts', () => {
    episode({ rule: 'cpu_busy', raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    run();
    episode({ rule: 'cpu_busy', raisedAgo: 15 * MIN, clearedAgo: 8 * MIN });
    episode({ rule: 'disk_full', raisedAgo: 15 * MIN, clearedAgo: 8 * MIN });
    run();
    expect(summaries()).toHaveLength(1);
    const body = JSON.parse(summaries()[0]!.payload).body as string;
    expect(body).toContain('3 alerts opened and cleared: cpu_busy ×2, disk_full ×1');
  });

  it('leaves a started summary alone and queues a new one', () => {
    episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    run();
    markStarted(db, summaries()[0]!.id, NOW);
    episode({ raisedAgo: 15 * MIN, clearedAgo: 8 * MIN });
    run();
    expect(summaries()).toHaveLength(2);
    expect(summaries().filter((s) => s.startedAt === null)).toHaveLength(1);
  });

  it('turns counts from rejected and abandoned rows into a summary even when nothing is coalesced', () => {
    addCount(db, 'w', 'rejected', 'cpu_busy', 2);
    addCount(db, 'w', 'abandoned', 'cpu_busy', 1);
    expect(run()).toEqual({ coalesced: 0, summaryQueued: true });
    const body = JSON.parse(summaries()[0]!.payload).body as string;
    expect(body).toContain('2 notifications were rejected by the endpoint');
    expect(body).toContain('1 notification could not be delivered');
  });

  it('queues no second summary when nothing new happened, and never coalesces or counts summaries', () => {
    episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    run();
    expect(run()).toEqual({ coalesced: 0, summaryQueued: false });
    expect(summaries()).toHaveLength(1);
    for (let i = 0; i < 101; i++)
      db.prepare(
        "INSERT INTO notifications (webhook_id, alert_id, event, rule_id, metric, payload, next_at, created_at) VALUES ('w', 0, 'summary', '', '', '{}', 1, 1)"
      ).run();
    expect(run().coalesced).toBe(0);
    expect(summaries()).toHaveLength(102);
  });
});

describe('atomicity', () => {
  it('changes nothing if the summary cannot be written, and succeeds on the next run', () => {
    const a = episode({ raisedAgo: 20 * MIN, clearedAgo: 10 * MIN });
    addCount(db, 'w', 'rejected', 'cpu_busy');
    db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON notifications WHEN NEW.event = 'summary' BEGIN SELECT RAISE(ABORT, 'boom'); END"
    );
    const before = getState(db, 'w').counts;
    expect(() => run()).toThrow(/boom/);
    expect(rowsOf().filter((r) => r.alertId === a.alert.id)).toHaveLength(2);
    expect(getState(db, 'w').counts).toEqual(before);
    expect(hasUnsummarized(db, 'w')).toBe(true);
    expect(summaries()).toEqual([]);
    db.exec('DROP TRIGGER boom');
    expect(run().summaryQueued).toBe(true);
    expect(rowsOf().filter((r) => r.alertId === a.alert.id)).toEqual([]);
    expect(summaries()).toHaveLength(1);
  });
});

const detailOf = () =>
  JSON.parse(
    (
      db
        .prepare(
          "SELECT detail FROM notifications WHERE event = 'summary' ORDER BY id DESC LIMIT 1"
        )
        .get() as { detail: string }
    ).detail
  ) as { since: number; counts: unknown[] };

describe('boundaries', () => {
  it('is over the cap at 101 pending rows, not at 100', () => {
    for (let i = 0; i < 50; i++) episode({ raisedAgo: 3 * MIN, clearedAgo: 1 * MIN });
    expect(rowsOf()).toHaveLength(100);
    expect(run().coalesced).toBe(0);
    episode({ raisedAgo: 3 * MIN }); // an open alert: one more row, now 101
    expect(run().coalesced).toBe(100);
    expect(rowsOf()).toHaveLength(1);
  });

  it('treats a row of exactly 5 minutes as old enough, and one a millisecond younger as not', () => {
    episode({ raisedAgo: ELIGIBLE_AFTER_MS, clearedAgo: 1 * MIN });
    expect(run().coalesced).toBe(2);
    episode({ raisedAgo: ELIGIBLE_AFTER_MS - 1, clearedAgo: 1 * MIN });
    expect(run().coalesced).toBe(0);
  });
});

describe('rows that must stay, for any shape of webhook', () => {
  it('keeps a started clear of a cleared-only webhook', () => {
    const a = episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN, raise: false });
    markStarted(db, rowFor(a.alert.id, 'cleared').id, NOW - 19 * MIN);
    expect(run(hook({ events: ['cleared'] })).coalesced).toBe(0);
    expect(events()).toEqual(['cleared']);
  });

  it('keeps a never-started clear whose raise was started, even for a cleared-only webhook', () => {
    const a = episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    markStarted(db, rowFor(a.alert.id, 'raised').id, NOW - 25 * MIN);
    expect(run(hook({ events: ['cleared'] })).coalesced).toBe(0);
    expect(events()).toEqual(['raised', 'cleared']);
  });

  it('copes with a started raise that has no clear row, open or cleared', () => {
    const open = episode({ raisedAgo: 30 * MIN });
    const over = episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN, clear: false });
    markStarted(db, rowFor(open.alert.id, 'raised').id, NOW - 25 * MIN);
    markStarted(db, rowFor(over.alert.id, 'raised').id, NOW - 25 * MIN);
    for (const events of [['raised', 'cleared'], ['cleared'], ['raised']] as const)
      expect(() => run(hook({ events: [...events] }))).not.toThrow();
    expect(rowsOf()).toHaveLength(2);
  });

  it('counts the clears a cleared-only webhook drops over the cap as dropped', () => {
    const hooked = hook({ events: ['cleared'] });
    for (let i = 0; i < 101; i++)
      episode({ raisedAgo: 3 * MIN, clearedAgo: 1 * MIN, raise: false });
    expect(run(hooked).coalesced).toBe(101);
    expect(getState(db, 'w').counts).toMatchObject({ dropped: 101, cleared: 0 });
  });
});

describe('the summary window', () => {
  it('starts when delivery went wrong, or now when it is not known', () => {
    episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    run();
    expect(detailOf().since).toBe(NOW);
    db.exec('DELETE FROM notifications');
    setDegraded(db, 'w', NOW - 40 * MIN);
    episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    run();
    expect(detailOf().since).toBe(NOW - 40 * MIN);
  });

  it('keeps the earliest start when it adds to a pending summary', () => {
    setDegraded(db, 'w', NOW - 40 * MIN);
    episode({ raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    run();
    db.prepare('UPDATE webhook_state SET degraded_since = ? WHERE webhook_id = ?').run(
      NOW - 10 * MIN,
      'w'
    );
    episode({ raisedAgo: 15 * MIN, clearedAgo: 8 * MIN });
    run();
    expect(summaries()).toHaveLength(1);
    expect(detailOf().since).toBe(NOW - 40 * MIN);
  });
});

describe('an alert that a rule edit closed and reopened unchanged', () => {
  /** A was raised and closed by an edit at the moment B (the same rule and metric) opened. */
  function edited(opts: { raiseForB: boolean }) {
    const raisedAt = NOW - 20 * MIN;
    const editedAt = NOW - 10 * MIN;
    const a = raiseAlert(db, {
      ruleId: 'cpu_busy',
      metric: 'cpu_load',
      severity: 'warning',
      message: 'busy',
      value: 1,
      raisedAt
    });
    clearAlert(db, a.id, editedAt, 'rule_changed');
    const b = raiseAlert(db, {
      ruleId: 'cpu_busy',
      metric: 'cpu_load',
      severity: 'warning',
      message: 'busy',
      value: 1,
      raisedAt: editedAt
    });
    const add = (alertId: number, at: number) =>
      insertNotification(db, {
        webhookId: 'w',
        alertId,
        event: 'raised',
        ruleId: 'cpu_busy',
        metric: 'cpu_load',
        payload: '{}',
        nextAt: at,
        createdAt: at
      });
    add(a.id, raisedAt);
    if (opts.raiseForB) add(b.id, editedAt);
    return { a, b };
  }

  it("keeps A's raise, which stands for B, so an alert that is still open is not lost", () => {
    const { a } = edited({ raiseForB: false });
    expect(run()).toEqual({ coalesced: 0, summaryQueued: false });
    expect(rowFor(a.id, 'raised')).toBeDefined();
    expect(getState(db, 'w').counts.opened_and_cleared).toBe(0);
  });

  it("drops A's raise when B has a raise of its own, as for any alert that ended", () => {
    const { a, b } = edited({ raiseForB: true });
    expect(run().coalesced).toBe(1);
    expect(rowsOf().map((r) => r.alertId)).toEqual([b.id]);
    expect(rowsOf().some((r) => r.alertId === a.id)).toBe(false);
  });
});

describe('while the endpoint rejects requests outright', () => {
  it('keeps counting, and makes one summary with all of it once the endpoint answers again', () => {
    setNeedsAttention(db, 'w', 'HTTP 401', NOW + 5 * MIN);
    addCount(db, 'w', 'rejected', 'cpu_busy', 3);
    episode({ rule: 'gone', raisedAgo: 30 * MIN, clearedAgo: 20 * MIN });
    expect(run()).toEqual({ coalesced: 2, summaryQueued: false });
    expect(summaries()).toEqual([]);
    expect(hasUnsummarized(db, 'w')).toBe(true);
    clearNeedsAttention(db, 'w');
    expect(run().summaryQueued).toBe(true);
    const body = JSON.parse(summaries()[0]!.payload).body as string;
    expect(body).toContain('3 notifications were rejected by the endpoint');
    expect(body).toContain('1 alert opened and cleared: gone ×1');
  });
});

describe('an alert that several unchanged rule edits closed and reopened', () => {
  const spec = {
    ruleId: 'cpu_busy',
    metric: 'cpu_load',
    severity: 'warning' as const,
    message: 'busy',
    value: 1
  };
  const raiseRow = (alertId: number, at: number) =>
    insertNotification(db, {
      webhookId: 'w',
      alertId,
      event: 'raised',
      ruleId: 'cpu_busy',
      metric: 'cpu_load',
      payload: '{}',
      nextAt: at,
      createdAt: at
    });
  /** A (raised, edited) -> B (edited) -> C (open): each edit closes one alert as the next opens. */
  function twoEdits() {
    const t0 = NOW - 30 * MIN;
    const t1 = NOW - 20 * MIN;
    const t2 = NOW - 10 * MIN;
    const a = raiseAlert(db, { ...spec, raisedAt: t0 });
    clearAlert(db, a.id, t1, 'rule_changed');
    const b = raiseAlert(db, { ...spec, raisedAt: t1 });
    clearAlert(db, b.id, t2, 'rule_changed');
    const c = raiseAlert(db, { ...spec, raisedAt: t2 });
    return { a, b, c, t0, t1, t2 };
  }

  it('keeps the first raise, which stands for the alert that is open after two edits', () => {
    const { a, t0 } = twoEdits();
    raiseRow(a.id, t0);
    expect(run()).toEqual({ coalesced: 0, summaryQueued: false });
    expect(rowFor(a.id, 'raised')).toBeDefined();
    expect(getState(db, 'w').counts.opened_and_cleared).toBe(0);
  });

  it('follows any number of edits', () => {
    const { a, c, t0, t2 } = twoEdits();
    clearAlert(db, c.id, t2 + 1 * MIN, 'rule_changed');
    raiseAlert(db, { ...spec, raisedAt: t2 + 1 * MIN });
    raiseRow(a.id, t0);
    expect(run().coalesced).toBe(0);
  });

  it('drops the raise when the last alert has a raise of its own (the last edit changed something)', () => {
    const { a, c, t0, t2 } = twoEdits();
    raiseRow(a.id, t0);
    raiseRow(c.id, t2);
    expect(run().coalesced).toBe(1);
    expect(rowsOf().map((r) => r.alertId)).toEqual([c.id]);
  });

  it('drops the first raise when the first edit changed something, and keeps the one the second edit left standing', () => {
    // A -> B changed (B has its own raise); B -> C unchanged (that raise stands for C)
    const { a, b, t0, t1 } = twoEdits();
    raiseRow(a.id, t0);
    raiseRow(b.id, t1);
    expect(run().coalesced).toBe(1);
    expect(rowsOf().map((r) => r.alertId)).toEqual([b.id]);
  });

  it('ends when the edits end without an open alert, and does not loop on edits made in one instant', () => {
    const t = NOW - 20 * MIN;
    const a = raiseAlert(db, { ...spec, raisedAt: t });
    clearAlert(db, a.id, t, 'rule_changed');
    const b = raiseAlert(db, { ...spec, raisedAt: t });
    clearAlert(db, b.id, t, 'rule_changed'); // A and B point at each other
    raiseRow(a.id, t);
    expect(run().coalesced).toBe(1);
    expect(rowsOf()).toEqual([]);
  });
});
