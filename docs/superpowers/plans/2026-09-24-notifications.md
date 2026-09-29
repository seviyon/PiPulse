# Phase 5b-3 Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an alert is raised or clears, PiPulse delivers a message to webhooks defined in an operator-owned file, through a durable outbox that retries for up to 6 hours, survives restarts and keeps order per webhook.

**Architecture:** A new workspace package `packages/notify` (built after `alerts`, before `api`) holds the config parser, JSON body templates, the versioned `AlertAction` interface with its webhook implementation, the outbox store (migration 7 in `packages/storage`), the enqueuer that turns engine events into outbox rows, and the sender loop. `server.ts` wires the engine's `onChange` to both the WebSocket feed and the enqueuer. `packages/api` serves read-only status at `GET /api/notify` and ships a `notify-test` command; `packages/web` shows a read-only Notifications section on the Settings page.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node ≥ 22.13 (`node:sqlite`, global `fetch`, `AbortSignal.timeout`), Fastify 5, Preact, Vitest 5 (happy-dom for web).

**Spec:** `docs/superpowers/specs/2026-09-24-notifications-design.md`

## Global Constraints

- Node.js `>=22.13.0`. No new runtime dependencies: HTTP via global `fetch`.
- No npm `pre*`/`post*` lifecycle hooks (this machine runs with `ignore-scripts=true`).
- Build order becomes storage → collector → alerts → **notify** → api → web (root `package.json` `build` script). A package's tests run against the built `dist/` of the packages it imports: `npm run build` before dependants' tests.
- Migrations 1–6 are never edited; migration 7 is appended.
- `PIPULSE_NOTIFY_FILE` (optional): `{ "webhooks": [ … ] }`; fields `id` (lowercase snake_case, unique), `url` (`http://`/`https://`), `method` (`POST` default, or `PUT`), `headers` (string map), `body` (JSON template), `events` (subset of `raised`,`cleared`; default both), `minSeverity` (`warning` default, or `critical`), `timeout` (duration `1s`–`60s`, default `10s`). Any problem stops startup with one line naming the webhook and field. Startup warns `PIPULSE_NOTIFY_FILE is readable by other users; chmod 600 it` when group/other can read the file.
- Placeholders: `event`, `ruleId`, `metric`, `metricLabel`, `severity`, `message`, `value`, `rawValue`, `raisedAt`, `clearedAt`, `duration`, `clearedBy`, `hostname`. Replaced only inside JSON string values; a string that is exactly one placeholder keeps the field's JSON type (`null` when missing); inside a longer string a missing value renders `""`. Unknown placeholders stop startup.
- Default body (no `body`): `{ "title": "{{hostname}}: {{message}}", "body": "{{metricLabel}} {{value}} ({{severity}}, {{event}})", "type": <apprise type> }`, type `warning` (warning raise), `failure` (critical raise), `success` (clear), `info` (test).
- Notify: every raise, except the re-raise that pairs with a `rule_changed` clear at the same timestamp when severity and message are unchanged; clears with `clearedBy: 'condition'`; a `rule_changed` clear that no raise pairs with within 30 s. Never: acknowledgements, `rule_removed` clears.
- Sender: one request at a time per webhook, oldest pending row first (later rows wait); 2xx = sent; non-2xx, timeout, network error or any 3xx (redirects not followed, `redirect: 'manual'`) = failed attempt; retry after 5 s doubling, capped at 5 min; give up after 6 h since the row was created with one log line `[pipulse] webhook <id>: gave up after <n> attempts (last: <reason>)`; a `next_at` more than 5 min ahead is pulled to now + 5 min; wakes on enqueue and at least every 5 s; prunes sent/failed rows 7 days after they finished, hourly; at startup pending rows for webhook ids no longer configured become `failed` with `webhook removed`.
- Secrets: webhook URLs (beyond the host), paths, queries and headers never appear in logs, API responses or the UI. At most 1 KB of a response body is read.
- No API endpoint writes webhook config or triggers a send.
- Colour never carries meaning alone on the dashboard: always an icon and words.
- `npm test`, `npm run lint`, and `npx prettier --check` on changed files pass before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec clarification: `AlertAction.deliver` resolves with nothing and rejects with an `Error` whose message is the short reason (`HTTP 503`, `timeout`, `connection refused`, `redirect (HTTP 302)`, `network error (ECODE)`); `notify-test` prints `<id>: delivered` or `<id>: failed (<reason>)`.
- Spec clarification: migration 7 also stores `failed_at` (time of the latest failed attempt) so the status can show "Last failed 10:40" even after a later success.

## Review Focus

1. **An alert message containing quotes, backslashes or `{{`** (e.g. a rule message `Disk "/" at {{90%}}`): the rendered body must stay valid JSON, and a `{{…}}` inside a _value_ must never be re-expanded. Test in Task 2.
2. **Editing an open rule when the webhook only listens to `raised`**: the pairing must use the closed alert row, not the outbox, so the re-raise is still suppressed when severity and message are unchanged. Test in Task 5.
3. **A receiver that hangs without answering**: the request must be aborted at the webhook's `timeout`, counted as a failed attempt, and must not block other webhooks. Test in Task 4 (action) and Task 6 (sender independence).
4. **A clock that jumps back hours right after a failure** (Pi without RTC): the row must still be retried within 5 minutes. Test in Task 6.
5. **`GET /api/notify` for a URL with credentials, path and query** (`https://user:pass@host:8000/notify/key?x=1`): the response carries `host` (`host:8000`) only — no userinfo, path or query anywhere in the JSON. Test in Task 7.

---

## File Structure

| File                                                                | Change | Responsibility                                                          |
| ------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `packages/storage/src/migrations.ts`                                | modify | Migration 7: `notifications` table                                      |
| `packages/notify/package.json`, `tsconfig.json`, `vitest.config.ts` | create | New workspace package (copies of packages/alerts')                      |
| `package.json` (root)                                               | modify | Build order includes notify                                             |
| `packages/notify/src/outbox.ts`                                     | create | SQLite access for the `notifications` table                             |
| `packages/notify/src/template.ts`                                   | create | Placeholders, template check/render, fields from an alert, default body |
| `packages/notify/src/config.ts`                                     | create | `PIPULSE_NOTIFY_FILE` parsing and validation                            |
| `packages/notify/src/action.ts`                                     | create | `AlertAction` interface and the webhook action                          |
| `packages/notify/src/enqueue.ts`                                    | create | Engine events → outbox rows (filters, pairing)                          |
| `packages/notify/src/sender.ts`                                     | create | Delivery loop, backoff, give-up, pruning; `startNotifications`          |
| `packages/notify/src/index.ts`                                      | create | Re-exports                                                              |
| `packages/api/src/notify-routes.ts`                                 | create | `GET /api/notify`                                                       |
| `packages/api/src/index.ts`, `server.ts`, `package.json`            | modify | Option `notify`, wiring, dependency on `@pipulse/notify`                |
| `packages/api/src/notify-test.ts`                                   | create | The `notify-test` command                                               |
| `packages/web/src/notifications.tsx`                                | create | Settings page Notifications section                                     |
| `packages/web/src/settings-page.tsx`, `types.ts`, `styles.css`      | modify | Section placement, wire type, styles                                    |
| `README.md`, `CLAUDE.md`, `docs/PLAN.md`                            | modify | Status and configuration docs                                           |

---

### Task 1: Migration 7, the notify package and its outbox store

**Files:**

- Modify: `packages/storage/src/migrations.ts` (append after migration 6)
- Create: `packages/notify/package.json`, `packages/notify/tsconfig.json`, `packages/notify/vitest.config.ts`, `packages/notify/src/outbox.ts`, `packages/notify/src/index.ts`
- Modify: root `package.json` (`build` script)
- Test: `packages/storage/test/migrations.test.ts`, `packages/notify/test/outbox.test.ts`

**Interfaces:**

- Produces (outbox.ts):

```ts
export type NotificationEvent = 'raised' | 'cleared';
export interface OutboxRow {
  id: number;
  webhookId: string;
  alertId: number;
  event: NotificationEvent;
  ruleId: string;
  metric: string;
  payload: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  nextAt: number;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
  failedAt: number | null;
}
export function insertNotification(
  db,
  row: { webhookId; alertId; event; ruleId; metric; payload; nextAt; createdAt }
): void;
export function headOf(db, webhookId: string): OutboxRow | undefined; // oldest pending
export function markSent(db, id: number, at: number): void;
export function markAttemptFailed(db, id: number, at: number, reason: string, nextAt: number): void; // attempts+1, last_error, failed_at
export function markGivenUp(db, id: number, at: number, reason: string): void; // status failed, attempts+1, last_error, failed_at
export function setNextAt(db, id: number, nextAt: number): void;
export function deletePendingClears(db, ruleId: string, metric: string): number; // pending 'cleared' rows for that rule+metric
export function failRemovedWebhooks(db, keep: string[], at: number): number; // pending rows of other ids → failed 'webhook removed'
export function pruneNotifications(db, before: number): number; // sent/failed rows finished before `before`
export function webhookStats(
  db,
  webhookId: string
): {
  pending: number;
  lastSuccessAt: number | null;
  lastFailure: { at: number; reason: string } | null;
};
```

- [ ] **Step 1: Write the failing migration test**

In `packages/storage/test/migrations.test.ts` (it has a `columns(db, table)` helper), append:

```ts
it('adds the notifications outbox (migration 7)', () => {
  const db = openDb(join(dir, 'seven.db'));
  expect(SCHEMA_VERSION).toBe(7);
  expect(columns(db, 'notifications')).toEqual([
    'id',
    'webhook_id',
    'alert_id',
    'event',
    'rule_id',
    'metric',
    'payload',
    'status',
    'attempts',
    'next_at',
    'last_error',
    'created_at',
    'sent_at',
    'failed_at'
  ]);
  db.close();
});
```

Update any other test asserting `SCHEMA_VERSION` is 6 (e.g. `packages/storage/test/settings.test.ts`) to 7.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/storage/test/migrations.test.ts`
Expected: FAIL — `SCHEMA_VERSION` is 6.

- [ ] **Step 3: Add migration 7**

Append to the `migrations` array in `packages/storage/src/migrations.ts`:

```ts
// 7: 5b-3. The notifications outbox: one row per alert event and webhook,
// delivered in order per webhook and retried until sent or given up.
// payload is the rendered body, frozen at the event; failed_at is the
// latest failed attempt, kept after a later success for the status line.
(db) => {
  db.exec(`
      CREATE TABLE notifications (
        id         INTEGER PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        alert_id   INTEGER NOT NULL,
        event      TEXT NOT NULL,
        rule_id    TEXT NOT NULL,
        metric     TEXT NOT NULL,
        payload    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        attempts   INTEGER NOT NULL DEFAULT 0,
        next_at    INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        sent_at    INTEGER,
        failed_at  INTEGER
      );
      CREATE INDEX idx_notifications_queue ON notifications(webhook_id, status, id);
    `);
};
```

Run the storage tests: PASS.

- [ ] **Step 4: Scaffold `packages/notify`**

`packages/notify/package.json`:

```json
{
  "name": "@pipulse/notify",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "NODE_OPTIONS=--disable-warning=ExperimentalWarning vitest run"
  },
  "dependencies": {
    "@pipulse/alerts": "*",
    "@pipulse/storage": "*"
  }
}
```

`tsconfig.json` and `vitest.config.ts`: copy `packages/alerts/tsconfig.json` and `packages/alerts/vitest.config.ts` unchanged. In the root `package.json` `build` script insert `npm run build --workspace=packages/notify && ` after the alerts build. Run `npm install` once so the workspace is linked and `package-lock.json` records it (commit the lock change). The root `vitest.config.ts` uses `test.projects: ['packages/*']`, so no change there.

- [ ] **Step 5: Write the failing outbox tests**

Create `packages/notify/test/outbox.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import {
  deletePendingClears,
  failRemovedWebhooks,
  headOf,
  insertNotification,
  markAttemptFailed,
  markGivenUp,
  markSent,
  pruneNotifications,
  setNextAt,
  webhookStats
} from '../src/outbox.js';

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const row = (over: Partial<Parameters<typeof insertNotification>[1]> = {}) => ({
  webhookId: 'apprise',
  alertId: 1,
  event: 'raised' as const,
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  payload: '{}',
  nextAt: 1000,
  createdAt: 1000,
  ...over
});

describe('outbox', () => {
  it('serves the oldest pending row per webhook and moves on once it is sent', () => {
    insertNotification(db, row());
    insertNotification(db, row({ event: 'cleared' }));
    insertNotification(db, row({ webhookId: 'ntfy' }));
    const first = headOf(db, 'apprise')!;
    expect(first).toMatchObject({ event: 'raised', status: 'pending', attempts: 0 });
    markSent(db, first.id, 2000);
    expect(headOf(db, 'apprise')).toMatchObject({ event: 'cleared' });
    expect(headOf(db, 'ntfy')).toMatchObject({ webhookId: 'ntfy' });
  });

  it('records failed attempts and giving up, and reports them in the stats', () => {
    insertNotification(db, row());
    const head = headOf(db, 'apprise')!;
    markAttemptFailed(db, head.id, 1500, 'HTTP 503', 6500);
    expect(headOf(db, 'apprise')).toMatchObject({
      attempts: 1,
      nextAt: 6500,
      lastError: 'HTTP 503',
      failedAt: 1500
    });
    setNextAt(db, head.id, 7000);
    expect(headOf(db, 'apprise')!.nextAt).toBe(7000);
    markGivenUp(db, head.id, 9000, 'timeout');
    expect(headOf(db, 'apprise')).toBeUndefined();
    expect(webhookStats(db, 'apprise')).toEqual({
      pending: 0,
      lastSuccessAt: null,
      lastFailure: { at: 9000, reason: 'timeout' }
    });
  });

  it('keeps the latest failure after a later success', () => {
    insertNotification(db, row());
    const head = headOf(db, 'apprise')!;
    markAttemptFailed(db, head.id, 1500, 'timeout', 1600);
    markSent(db, head.id, 1700);
    insertNotification(db, row({ createdAt: 1800, nextAt: 1800 }));
    expect(webhookStats(db, 'apprise')).toEqual({
      pending: 1,
      lastSuccessAt: 1700,
      lastFailure: { at: 1500, reason: 'timeout' }
    });
  });

  it('deletes pending clears for one rule and metric', () => {
    insertNotification(db, row({ event: 'cleared' }));
    insertNotification(db, row({ event: 'cleared', metric: 'other' }));
    insertNotification(db, row({ event: 'raised' }));
    expect(deletePendingClears(db, 'cpu_hot', 'cpu_temperature')).toBe(1);
    expect(headOf(db, 'apprise')).toMatchObject({ event: 'cleared', metric: 'other' });
  });

  it('fails pending rows of removed webhooks and prunes finished rows', () => {
    insertNotification(db, row({ webhookId: 'gone' }));
    insertNotification(db, row());
    expect(failRemovedWebhooks(db, ['apprise'], 5000)).toBe(1);
    expect(webhookStats(db, 'gone').lastFailure).toEqual({ at: 5000, reason: 'webhook removed' });
    markSent(db, headOf(db, 'apprise')!.id, 6000);
    expect(pruneNotifications(db, 5500)).toBe(1); // the 'gone' row finished at 5000
    expect(pruneNotifications(db, 7000)).toBe(1);
  });
});
```

- [ ] **Step 6: Implement `packages/notify/src/outbox.ts`**

```ts
import type { PiPulseDb } from '@pipulse/storage';

export type NotificationEvent = 'raised' | 'cleared';

export interface OutboxRow {
  id: number;
  webhookId: string;
  alertId: number;
  event: NotificationEvent;
  ruleId: string;
  metric: string;
  payload: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  nextAt: number;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
  failedAt: number | null;
}

const COLUMNS = `id, webhook_id AS webhookId, alert_id AS alertId, event, rule_id AS ruleId,
  metric, payload, status, attempts, next_at AS nextAt, last_error AS lastError,
  created_at AS createdAt, sent_at AS sentAt, failed_at AS failedAt`;

export function insertNotification(
  db: PiPulseDb,
  row: Pick<
    OutboxRow,
    'webhookId' | 'alertId' | 'event' | 'ruleId' | 'metric' | 'payload' | 'nextAt' | 'createdAt'
  >
): void {
  db.prepare(
    `INSERT INTO notifications (webhook_id, alert_id, event, rule_id, metric, payload, next_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.webhookId,
    row.alertId,
    row.event,
    row.ruleId,
    row.metric,
    row.payload,
    row.nextAt,
    row.createdAt
  );
}

/** The webhook's oldest pending row: later rows wait behind it, so order holds per webhook. */
export function headOf(db: PiPulseDb, webhookId: string): OutboxRow | undefined {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM notifications WHERE webhook_id = ? AND status = 'pending' ORDER BY id LIMIT 1`
    )
    .get(webhookId) as unknown as OutboxRow | undefined;
}

export function markSent(db: PiPulseDb, id: number, at: number): void {
  db.prepare(
    `UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`
  ).run(at, id);
}
```

Note `markSent` counts the successful attempt too. Then `markAttemptFailed` (`attempts = attempts + 1, last_error = ?, failed_at = ?, next_at = ?`), `markGivenUp` (`status = 'failed', attempts = attempts + 1, last_error = ?, failed_at = ?`), `setNextAt`, `deletePendingClears` (`DELETE … WHERE status = 'pending' AND event = 'cleared' AND rule_id = ? AND metric = ?`, return `changes`), `failRemovedWebhooks` (`UPDATE … SET status = 'failed', last_error = 'webhook removed', failed_at = ? WHERE status = 'pending' AND webhook_id NOT IN (…)`; build the `?` list from `keep`; with an empty `keep`, every pending row), `pruneNotifications` (`DELETE … WHERE (status = 'sent' AND sent_at < ?) OR (status = 'failed' AND failed_at < ?)`), and `webhookStats`:

```ts
export function webhookStats(db: PiPulseDb, webhookId: string) {
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications WHERE webhook_id = ? AND status = 'pending'`
      )
      .get(webhookId) as { n: number }
  ).n;
  const sent = db
    .prepare(`SELECT MAX(sent_at) AS at FROM notifications WHERE webhook_id = ?`)
    .get(webhookId) as { at: number | null };
  const failure = db
    .prepare(
      `SELECT failed_at AS at, last_error AS reason FROM notifications WHERE webhook_id = ? AND failed_at IS NOT NULL ORDER BY failed_at DESC, id DESC LIMIT 1`
    )
    .get(webhookId) as { at: number; reason: string } | undefined;
  return { pending, lastSuccessAt: sent.at, lastFailure: failure ?? null };
}
```

`packages/notify/src/index.ts`: `export * from './outbox.js';` (later tasks add their modules).

- [ ] **Step 7: Run and commit**

Run: `npm run build && npx vitest run packages/notify packages/storage` → PASS; then `npm test`, `npm run lint`, prettier on changed files.

```bash
git add packages/storage packages/notify package.json package-lock.json
git commit -m "Add the notifications outbox (migration 7) and the notify package

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Templates and notification fields

**Files:**

- Create: `packages/notify/src/template.ts`
- Modify: `packages/notify/src/index.ts`
- Test: `packages/notify/test/template.test.ts`

**Interfaces:**

- Consumes: `Alert` from `@pipulse/alerts`.
- Produces:

```ts
export const PLACEHOLDERS: readonly string[]; // the 13 names from Global Constraints
export type Fields = Record<string, string | number | null>;
export interface MetricLabel {
  id: string;
  label: string;
  unit: string;
}
export class TemplateError extends Error {} // message names the placeholder
export function checkTemplate(template: unknown): void; // throws TemplateError on an unknown placeholder
export function renderTemplate(template: unknown, fields: Fields): unknown;
export function fieldsFor(
  event: 'raised' | 'cleared' | 'test',
  alert: Alert,
  context: { hostname: string; metrics: MetricLabel[] }
): Fields;
export function defaultBody(
  event: 'raised' | 'cleared' | 'test',
  severity: 'warning' | 'critical'
): unknown;
export function renderPayload(
  body: unknown | undefined,
  event: 'raised' | 'cleared' | 'test',
  alert: Alert,
  context: { hostname: string; metrics: MetricLabel[] }
): string; // JSON string
export function formatLocalTime(ms: number): string; // "2026-09-24 10:42" in the server's time zone
export function formatDuration(ms: number): string; // "45 s" | "12 min" | "3 h" | "2 d" (largest unit, rounded down)
export function formatValue(value: number, unit: string): string;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/notify/test/template.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Alert } from '@pipulse/alerts';
import {
  checkTemplate,
  defaultBody,
  fieldsFor,
  formatDuration,
  formatValue,
  renderPayload,
  renderTemplate,
  TemplateError
} from '../src/template.js';

const MIN = 60_000;
const alert: Alert = {
  id: 7,
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  severity: 'critical',
  message: 'CPU running hot',
  value: 82.44,
  raisedAt: new Date(2026, 8, 24, 10, 42).getTime(),
  clearedAt: null,
  clearedBy: null,
  acknowledgedAt: null,
  ruleHash: null
};
const context = {
  hostname: 'Io',
  metrics: [{ id: 'cpu_temperature', label: 'CPU temperature', unit: '°C' }]
};

describe('templates', () => {
  it('replaces placeholders only inside strings and keeps a lone placeholder typed', () => {
    const fields = fieldsFor('raised', alert, context);
    expect(
      renderTemplate(
        {
          n: 3,
          t: '{{severity}}: {{message}}',
          v: '{{rawValue}}',
          c: '{{clearedAt}}',
          s: 'at {{clearedAt}}.'
        },
        fields
      )
    ).toEqual({ n: 3, t: 'critical: CPU running hot', v: 82.44, c: null, s: 'at .' });
    expect(renderTemplate(['{{hostname}}', { deep: ['{{metric}}'] }], fields)).toEqual([
      'Io',
      { deep: ['cpu_temperature'] }
    ]);
  });

  it('keeps JSON valid and never re-expands braces from a value', () => {
    const tricky = { ...alert, message: 'Disk "/" at {{90%}} \\ done' };
    const payload = renderPayload({ text: '{{message}}' }, 'raised', tricky, context);
    expect(JSON.parse(payload)).toEqual({ text: 'Disk "/" at {{90%}} \\ done' });
  });

  it('refuses unknown placeholders anywhere in the template', () => {
    expect(() => checkTemplate({ a: ['x {{nope}}'] })).toThrow(TemplateError);
    expect(() => checkTemplate({ a: ['x {{nope}}'] })).toThrow(/nope/);
    expect(() => checkTemplate({ a: '{{message}} {{hostname}}' })).not.toThrow();
  });

  it('fills fields for a raise and a clear', () => {
    expect(fieldsFor('raised', alert, context)).toMatchObject({
      event: 'raised',
      metricLabel: 'CPU temperature',
      value: '82.4 °C',
      rawValue: 82.44,
      raisedAt: '2026-09-24 10:42',
      clearedAt: null,
      duration: null,
      clearedBy: null,
      hostname: 'Io'
    });
    const cleared = {
      ...alert,
      clearedAt: alert.raisedAt + 12 * MIN,
      clearedBy: 'condition' as const
    };
    expect(fieldsFor('cleared', cleared, context)).toMatchObject({
      event: 'cleared',
      duration: '12 min',
      clearedBy: 'condition'
    });
  });

  it('formats durations and values', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(3 * 60 * MIN + 5 * MIN)).toBe('3 h');
    expect(formatDuration(2 * 24 * 60 * MIN)).toBe('2 d');
    expect(formatValue(81, '%')).toBe('81 %');
    expect(formatValue(3, '')).toBe('3');
    expect(formatValue(0x50005, 'flags')).toBe('0x50005');
  });

  it('builds the Apprise default body with a type per event', () => {
    const body = (event: 'raised' | 'cleared' | 'test', severity: 'warning' | 'critical') =>
      JSON.parse(renderPayload(undefined, event, { ...alert, severity }, context));
    expect(body('raised', 'critical')).toEqual({
      title: 'Io: CPU running hot',
      body: 'CPU temperature 82.4 °C (critical, raised)',
      type: 'failure'
    });
    expect(body('raised', 'warning').type).toBe('warning');
    expect(body('cleared', 'critical').type).toBe('success');
    expect(body('test', 'warning').type).toBe('info');
    expect(defaultBody('raised', 'warning')).toMatchObject({ title: '{{hostname}}: {{message}}' });
  });
});
```

A silence alert (`value: null`) renders `rawValue` as `null` and `value` as `null` (lone) / `""` (in text) — add one assertion for it.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run packages/notify/test/template.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `packages/notify/src/template.ts`**

```ts
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
```

Then:

- `formatLocalTime(ms)`: `const d = new Date(ms)` and `YYYY-MM-DD HH:MM` from local getters, zero-padded.
- `formatDuration(ms)`: `d` if ≥ 1 day, else `h` if ≥ 1 hour, else `min` if ≥ 1 minute, else `s`; `Math.floor`.
- `formatValue(value, unit)`: `flags` → `0x` + hex; otherwise `String(Number(value.toFixed(1)))` plus `' ' + unit` when `unit` is non-empty.
- `fieldsFor(event, alert, context)`: `metricLabel` from `context.metrics` (fall back to the id); `value` = `alert.value === null ? null : formatValue(alert.value, unit)`; `rawValue` = `alert.value`; `raisedAt` = `formatLocalTime(alert.raisedAt)`; `clearedAt`/`duration`/`clearedBy` = `null` unless `alert.clearedAt !== null` (then `formatLocalTime`, `formatDuration(clearedAt - raisedAt)`, `alert.clearedBy`); `event`, `ruleId`, `metric`, `severity`, `message`, `hostname` as given.
- `defaultBody(event, severity)`: `{ title: '{{hostname}}: {{message}}', body: '{{metricLabel}} {{value}} ({{severity}}, {{event}})', type }` where `type` = `'info'` for test, `'success'` for cleared, `'failure'` for a critical raise, else `'warning'`.
- `renderPayload(body, event, alert, context)`: `JSON.stringify(renderTemplate(body ?? defaultBody(event, alert.severity), fieldsFor(event, alert, context)))`.

Add `export * from './template.js';` to `index.ts`.

- [ ] **Step 4: Run and commit**

Run the template tests → PASS; `npm test`, lint, prettier.

```bash
git add packages/notify
git commit -m "Render notification bodies from JSON templates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The notify file

**Files:**

- Create: `packages/notify/src/config.ts`
- Modify: `packages/notify/src/index.ts`
- Test: `packages/notify/test/config.test.ts`

**Interfaces:**

- Consumes: `checkTemplate`, `TemplateError` (Task 2); `parseDuration` from `@pipulse/storage`.
- Produces:

```ts
export interface WebhookConfig {
  id: string;
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  body?: unknown;
  events: ('raised' | 'cleared')[];
  minSeverity: 'warning' | 'critical';
  timeoutMs: number;
}
export interface NotifyFile {
  name: string;
  text: string;
  worldReadable: boolean;
}
export class NotifyConfigError extends Error {}
export function readNotifyFile(path: string): NotifyFile; // unreadable → NotifyConfigError naming PIPULSE_NOTIFY_FILE and the code
export function parseNotifyConfig(file: { name: string; text: string }): WebhookConfig[];
export function urlHost(url: string): string; // "host:port" only
```

- [ ] **Step 1: Write the failing tests**

Create `packages/notify/test/config.test.ts` covering, each asserting the exact message fragment:

```ts
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotifyConfigError, parseNotifyConfig, readNotifyFile, urlHost } from '../src/config.js';

const parse = (webhooks: unknown) =>
  parseNotifyConfig({ name: 'notify.json', text: JSON.stringify({ webhooks }) });
const fails = (webhooks: unknown, pattern: RegExp) =>
  expect(() => parse(webhooks)).toThrow(pattern);

describe('parseNotifyConfig', () => {
  it('applies defaults', () => {
    expect(parse([{ id: 'apprise', url: 'http://apprise.lan:8000/notify/pi' }])).toEqual([
      {
        id: 'apprise',
        url: 'http://apprise.lan:8000/notify/pi',
        method: 'POST',
        headers: {},
        events: ['raised', 'cleared'],
        minSeverity: 'warning',
        timeoutMs: 10_000
      }
    ]);
  });

  it('keeps a body template, headers and filters', () => {
    const [hook] = parse([
      {
        id: 'ntfy',
        url: 'https://ntfy.sh/pi',
        method: 'PUT',
        headers: { Authorization: 'Bearer x' },
        body: { message: '{{message}}' },
        events: ['raised'],
        minSeverity: 'critical',
        timeout: '30s'
      }
    ]);
    expect(hook).toMatchObject({
      method: 'PUT',
      headers: { Authorization: 'Bearer x' },
      body: { message: '{{message}}' },
      events: ['raised'],
      minSeverity: 'critical',
      timeoutMs: 30_000
    });
  });

  it('names the webhook and field for every problem', () => {
    fails(
      [{ id: 'a', url: 'http://x', bogus: 1 }],
      /notify\.json webhooks\[0\] \("a"\): unknown field "bogus"/
    );
    fails([{ id: 'Bad', url: 'http://x' }], /id must be lowercase snake_case/);
    fails(
      [
        { id: 'a', url: 'http://x' },
        { id: 'a', url: 'http://y' }
      ],
      /webhook id "a" appears twice/
    );
    fails([{ id: 'a', url: 'ftp://x' }], /url must be an http:\/\/ or https:\/\/ URL/);
    fails([{ id: 'a', url: 'http://x', method: 'GET' }], /method must be POST or PUT/);
    fails([{ id: 'a', url: 'http://x', headers: { A: 1 } }], /headers must map names to strings/);
    fails(
      [{ id: 'a', url: 'http://x', events: ['acknowledged'] }],
      /events must be a non-empty list of raised, cleared/
    );
    fails(
      [{ id: 'a', url: 'http://x', minSeverity: 'info' }],
      /minSeverity must be warning or critical/
    );
    fails([{ id: 'a', url: 'http://x', timeout: '5m' }], /timeout/);
    fails([{ id: 'a', url: 'http://x', timeout: '2min' }], /timeout must be between 1s and 60s/);
    fails(
      [{ id: 'a', url: 'http://x', body: { t: '{{nope}}' } }],
      /\("a"\): body: unknown placeholder \{\{nope\}\}/
    );
    expect(() => parseNotifyConfig({ name: 'notify.json', text: '{' })).toThrow(
      /notify\.json is not valid JSON/
    );
    expect(() => parseNotifyConfig({ name: 'notify.json', text: '{}' })).toThrow(
      /must be an object with a "webhooks" array/
    );
  });
});

describe('readNotifyFile and urlHost', () => {
  it('reads the file and says whether others can read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-notify-'));
    const path = join(dir, 'notify.json');
    writeFileSync(path, '{"webhooks":[]}');
    chmodSync(path, 0o600);
    expect(readNotifyFile(path)).toEqual({
      name: path,
      text: '{"webhooks":[]}',
      worldReadable: false
    });
    chmodSync(path, 0o644);
    expect(readNotifyFile(path).worldReadable).toBe(true);
    expect(() => readNotifyFile(join(dir, 'missing.json'))).toThrow(
      /PIPULSE_NOTIFY_FILE .* could not be read: ENOENT/
    );
  });

  it('shows the host only', () => {
    expect(urlHost('https://user:pass@apprise.lan:8000/notify/key?x=1')).toBe('apprise.lan:8000');
  });
});
```

- [ ] **Step 2: Run to see them fail**, then **Step 3: implement `config.ts`** following `packages/alerts/src/rules.ts`'s style: a `FIELDS` allow-list (`id`, `url`, `method`, `headers`, `body`, `events`, `minSeverity`, `timeout`), a `fail(problem)` closure producing `` `${name} webhooks[${i}]${label}: ${problem}` `` where `label` is `` ` ("${id}")` `` when the id is a string, `parseDuration('timeout', value)` (catch and re-throw its message through `fail`) plus the 1 s–60 s range check, `new URL(url)` with protocol `http:`/`https:`, and `checkTemplate(body)` with a `TemplateError` re-thrown as `fail(\`body: ${error.message}\`)`. `readNotifyFile`uses`readFileSync`and`statSync(path).mode & 0o077`for`worldReadable`, wrapping errors as `` `PIPULSE_NOTIFY_FILE ${path} could not be read: ${code}` ``. `urlHost(url)`=`new URL(url).host`.

Add `export * from './config.js';` to `index.ts`.

- [ ] **Step 4: Run and commit**

```bash
git add packages/notify
git commit -m "Read webhooks from PIPULSE_NOTIFY_FILE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `AlertAction` and the webhook action

**Files:**

- Create: `packages/notify/src/action.ts`
- Modify: `packages/notify/src/index.ts`
- Test: `packages/notify/test/action.test.ts`

**Interfaces:**

- Consumes: `WebhookConfig` (Task 3).
- Produces:

```ts
export const ALERT_ACTION_API_VERSION = 1;
export interface AlertAction {
  id: string;
  apiVersion: 1;
  /** Sends one rendered notification; resolves on success, rejects with an Error whose message is a short reason. */
  deliver(payload: string, signal: AbortSignal): Promise<void>;
}
export function createWebhookAction(webhook: WebhookConfig, fetchImpl?: typeof fetch): AlertAction;
```

- [ ] **Step 1: Write the failing tests** with a real local server:

```ts
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebhookAction } from '../src/action.js';
import type { WebhookConfig } from '../src/config.js';

let server: Server;
let handler: (
  req: IncomingMessage,
  body: string
) => { status: number; headers?: Record<string, string>; body?: string } | 'hang';
let received: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
let base: string;
beforeEach(async () => {
  received = [];
  handler = () => ({ status: 200 });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const answer = handler(req, body);
      if (answer === 'hang') return;
      res.writeHead(answer.status, answer.headers).end(answer.body ?? '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const hook = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  id: 'test',
  url: `${base}/notify/key`,
  method: 'POST',
  headers: {},
  events: ['raised', 'cleared'],
  minSeverity: 'warning',
  timeoutMs: 1000,
  ...over
});
const deliver = (over: Partial<WebhookConfig> = {}, timeoutMs = 1000) =>
  createWebhookAction(hook(over)).deliver('{"a":1}', AbortSignal.timeout(timeoutMs));

describe('webhook action', () => {
  it('sends the payload as JSON with the configured method and headers', async () => {
    await deliver({ method: 'PUT', headers: { Authorization: 'Bearer t' } });
    expect(received[0]).toMatchObject({ method: 'PUT', url: '/notify/key', body: '{"a":1}' });
    expect(received[0]!.headers).toMatchObject({
      authorization: 'Bearer t',
      'content-type': 'application/json'
    });
  });

  it('rejects with a short reason for non-2xx, redirects, timeouts and refused connections', async () => {
    handler = () => ({ status: 503, body: 'x'.repeat(5000) });
    await expect(deliver()).rejects.toThrow(/^HTTP 503$/);
    handler = () => ({ status: 302, headers: { location: 'http://example.com/' } });
    await expect(deliver()).rejects.toThrow(/^redirect \(HTTP 302\)$/);
    expect(received).toHaveLength(2); // the redirect was not followed
    handler = () => 'hang';
    await expect(deliver({}, 200)).rejects.toThrow(/^timeout$/);
    await expect(
      createWebhookAction(hook({ url: 'http://127.0.0.1:1/x' })).deliver(
        '{}',
        AbortSignal.timeout(1000)
      )
    ).rejects.toThrow(/^connection refused$/);
  });

  it('never puts the URL in a reason', async () => {
    handler = () => ({ status: 500 });
    await expect(deliver({ url: `${base}/secret-key?token=abc` })).rejects.toThrow(/^HTTP 500$/);
  });
});
```

- [ ] **Step 2: Implement `action.ts`**:

```ts
import type { WebhookConfig } from './config.js';

export const ALERT_ACTION_API_VERSION = 1;

/**
 * One way of telling someone about an alert. The outbox and sender know only
 * this interface; an action owns its destination, timeout and error wording.
 * Versioned on its own, like CollectorPlugin.
 */
export interface AlertAction {
  id: string;
  apiVersion: 1;
  /** Sends one rendered notification; resolves on success, rejects with an Error whose message is a short reason. */
  deliver(payload: string, signal: AbortSignal): Promise<void>;
}

const MAX_RESPONSE_BYTES = 1024;

/** Reads at most 1 KB of a response, so a huge or endless body can't hold the sender. */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let read = 0;
  while (read < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) return;
    read += value.byteLength;
  }
  await reader.cancel();
}

function reasonOf(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'timeout';
  const cause = (error as { cause?: { code?: string } }).cause;
  if (cause?.code === 'ECONNREFUSED') return 'connection refused';
  return `network error (${cause?.code ?? 'unknown'})`;
}

export function createWebhookAction(
  webhook: WebhookConfig,
  fetchImpl: typeof fetch = fetch
): AlertAction {
  return {
    id: webhook.id,
    apiVersion: 1,
    async deliver(payload, signal) {
      let response: Response;
      try {
        response = await fetchImpl(webhook.url, {
          method: webhook.method,
          headers: { ...webhook.headers, 'content-type': 'application/json' },
          body: payload,
          redirect: 'manual',
          signal
        });
      } catch (error) {
        throw new Error(reasonOf(error, signal));
      }
      try {
        await drain(response);
      } catch {
        // The status is what matters; a broken body after it doesn't change it.
      }
      if (response.status >= 300 && response.status < 400)
        throw new Error(`redirect (HTTP ${response.status})`);
      if (response.status < 200 || response.status >= 300)
        throw new Error(`HTTP ${response.status}`);
    }
  };
}
```

(`redirect: 'manual'` in Node's fetch returns the 3xx response itself. If a test shows Node reports status `0` for it, treat `response.type === 'opaqueredirect'` as `redirect (HTTP 3xx)` and adjust the expected message to `redirect` only — record that in the report.)

Add `export * from './action.js';` to `index.ts`.

- [ ] **Step 3: Run and commit**

```bash
git add packages/notify
git commit -m "Add the AlertAction interface and the webhook action

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Enqueuing engine events

**Files:**

- Create: `packages/notify/src/enqueue.ts`
- Modify: `packages/notify/src/index.ts`
- Test: `packages/notify/test/enqueue.test.ts`

**Interfaces:**

- Consumes: `AlertEvent`, `raiseAlert`, `clearAlert` (tests) from `@pipulse/alerts`; `insertNotification`, `deletePendingClears` (Task 1); `renderPayload`, `MetricLabel` (Task 2); `WebhookConfig` (Task 3).
- Produces:

```ts
export const CHANGED_CLEAR_DELAY_MS = 30_000;
export function createEnqueuer(
  db: PiPulseDb,
  options: {
    webhooks: WebhookConfig[];
    hostname: string;
    metrics: MetricLabel[];
    now?: () => number;
    onQueued?: () => void;
    onError?: (error: unknown) => void;
  }
): (event: AlertEvent) => void;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/notify/test/enqueue.test.ts`. Use real alert rows (`raiseAlert`/`clearAlert` from `@pipulse/alerts`) because pairing reads the closed alert:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { clearAlert, raiseAlert, type AlertEvent } from '@pipulse/alerts';
import { createEnqueuer, CHANGED_CLEAR_DELAY_MS } from '../src/enqueue.js';
import type { WebhookConfig } from '../src/config.js';

const T = 1_790_000_000_000;
let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const hook = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  id: 'all',
  url: 'http://x',
  method: 'POST',
  headers: {},
  events: ['raised', 'cleared'],
  minSeverity: 'warning',
  timeoutMs: 1000,
  ...over
});
const rows = () =>
  db
    .prepare(
      'SELECT webhook_id AS w, event, next_at AS nextAt, payload FROM notifications ORDER BY id'
    )
    .all() as { w: string; event: string; nextAt: number; payload: string }[];
const base = {
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  severity: 'critical' as const,
  message: 'CPU running hot',
  value: 82
};
const enqueuer = (webhooks: WebhookConfig[]) =>
  createEnqueuer(db, {
    webhooks,
    hostname: 'Io',
    metrics: [{ id: 'cpu_temperature', label: 'CPU temperature', unit: '°C' }],
    now: () => T
  });
const raised = (over = {}): AlertEvent => ({
  type: 'raised',
  alert: raiseAlert(db, { ...base, raisedAt: T, ...over })
});

describe('createEnqueuer', () => {
  it('queues a raise and a condition clear for every matching webhook, due now', () => {
    const enqueue = enqueuer([
      hook(),
      hook({ id: 'crit', minSeverity: 'critical' }),
      hook({ id: 'raises', events: ['raised'] })
    ]);
    const r = raised({ severity: 'warning' });
    enqueue(r);
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 1000, 'condition') });
    expect(rows().map((x) => [x.w, x.event, x.nextAt])).toEqual([
      ['all', 'raised', T],
      ['raises', 'raised', T],
      ['all', 'cleared', T]
    ]);
    expect(JSON.parse(rows()[0]!.payload)).toMatchObject({ type: 'warning' });
  });

  it('sends nothing for rule_removed clears', () => {
    const enqueue = enqueuer([hook()]);
    const r = raised();
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T, 'rule_removed') });
    expect(rows().map((x) => x.event)).toEqual([]);
  });

  it("drops an edit's close and reopen when severity and message are unchanged", () => {
    const enqueue = enqueuer([hook()]);
    const r = raised();
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    expect(rows()).toEqual([
      expect.objectContaining({ event: 'cleared', nextAt: T + CHANGED_CLEAR_DELAY_MS })
    ]);
    enqueue(raised({ raisedAt: T + 5000 }));
    expect(rows()).toEqual([]);
  });

  it('announces the reopen when severity or message changed', () => {
    const enqueue = enqueuer([hook()]);
    const r = raised({ severity: 'warning' });
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    enqueue(raised({ raisedAt: T + 5000 }));
    expect(rows().map((x) => x.event)).toEqual(['raised']);
  });

  it('pairs from the closed alert even for a webhook that only listens to raises', () => {
    const enqueue = enqueuer([hook({ events: ['raised'] })]);
    const r = raised();
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    enqueue(raised({ raisedAt: T + 5000 }));
    expect(rows()).toEqual([]);
  });

  it('keeps the delayed clear when nothing reopens, and reports errors instead of throwing', () => {
    const errors: unknown[] = [];
    const enqueue = createEnqueuer(db, {
      webhooks: [hook()],
      hostname: 'Io',
      metrics: [],
      now: () => T,
      onError: (e) => errors.push(e)
    });
    const r = raised();
    enqueue({ type: 'cleared', alert: clearAlert(db, r.alert.id, T + 5000, 'rule_changed') });
    expect(rows().map((x) => x.event)).toEqual(['cleared']);
    db.exec('DROP TABLE notifications');
    expect(() => enqueue(raised({ metric: 'other' }))).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
```

(`raised()` with the same rule and metric while the old one is still open would violate the open-alert unique index; the tests always clear first, as the engine does.)

- [ ] **Step 2: Implement `enqueue.ts`**

```ts
import type { PiPulseDb } from '@pipulse/storage';
import type { Alert, AlertEvent } from '@pipulse/alerts';
import type { WebhookConfig } from './config.js';
import { deletePendingClears, insertNotification, type NotificationEvent } from './outbox.js';
import { renderPayload, type MetricLabel } from './template.js';

/** How long a rule_changed clear waits for its reopen before it is sent as a real clear. */
export const CHANGED_CLEAR_DELAY_MS = 30_000;

const RANK = { warning: 0, critical: 1 } as const;

/**
 * Turns engine events into outbox rows, synchronously, right after the engine
 * wrote the alert row. Never throws into the engine: problems go to onError.
 */
export function createEnqueuer(
  db: PiPulseDb,
  options: {
    webhooks: WebhookConfig[];
    hostname: string;
    metrics: MetricLabel[];
    now?: () => number;
    onQueued?: () => void;
    onError?: (error: unknown) => void;
  }
): (event: AlertEvent) => void {
  const now = options.now ?? Date.now;
  const context = { hostname: options.hostname, metrics: options.metrics };

  const queue = (event: NotificationEvent, alert: Alert, nextAt: number) => {
    let queued = false;
    for (const webhook of options.webhooks) {
      if (!webhook.events.includes(event)) continue;
      if (RANK[alert.severity] < RANK[webhook.minSeverity]) continue;
      insertNotification(db, {
        webhookId: webhook.id,
        alertId: alert.id,
        event,
        ruleId: alert.ruleId,
        metric: alert.metric,
        payload: renderPayload(webhook.body, event, alert, context),
        nextAt,
        createdAt: now()
      });
      queued = true;
    }
    if (queued) options.onQueued?.();
  };

  /** The alert an edit closed at the moment this one opened, if any. */
  const closedByEdit = (alert: Alert) =>
    db
      .prepare(
        `SELECT severity, message FROM alerts WHERE rule_id = ? AND metric = ? AND cleared_by = 'rule_changed' AND cleared_at = ? ORDER BY id DESC LIMIT 1`
      )
      .get(alert.ruleId, alert.metric, alert.raisedAt) as
      { severity: string; message: string } | undefined;

  return (event) => {
    if (options.webhooks.length === 0) return;
    try {
      const { alert } = event;
      if (event.type === 'cleared') {
        if (alert.clearedBy === 'rule_removed') return;
        const delayed = alert.clearedBy === 'rule_changed';
        queue('cleared', alert, now() + (delayed ? CHANGED_CLEAR_DELAY_MS : 0));
        return;
      }
      const previous = closedByEdit(alert);
      if (previous) {
        deletePendingClears(db, alert.ruleId, alert.metric);
        if (previous.severity === alert.severity && previous.message === alert.message) return;
      }
      queue('raised', alert, now());
    } catch (error) {
      options.onError?.(error);
    }
  };
}
```

`AlertEvent` is `{ type: 'raised' | 'cleared'; alert: Alert }` in `@pipulse/alerts`; if its type union ever includes other values, ignore them. Add `export * from './enqueue.js';` to `index.ts`.

- [ ] **Step 3: Run and commit**

```bash
git add packages/notify
git commit -m "Queue notifications from alert raises and clears

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The sender and `startNotifications`

**Files:**

- Create: `packages/notify/src/sender.ts`
- Modify: `packages/notify/src/index.ts`
- Test: `packages/notify/test/sender.test.ts`

**Interfaces:**

- Consumes: outbox functions (Task 1), `AlertAction`, `createWebhookAction` (Task 4), `createEnqueuer` (Task 5), `WebhookConfig`, `urlHost` (Task 3), `MetricLabel` (Task 2).
- Produces:

```ts
export const FIRST_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 5 * 60_000;
export const GIVE_UP_AFTER_MS = 6 * 60 * 60_000;
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;
export function retryDelay(attempts: number): number; // attempts already made: 1 → 5 s, 2 → 10 s, … capped at 5 min
/** Delivers at most one due row per webhook, in parallel across webhooks; resolves to how many were sent. */
export function sendDue(
  db: PiPulseDb,
  actions: { action: AlertAction; timeoutMs: number }[],
  options: {
    now: () => number;
    onGiveUp?: (webhookId: string, attempts: number, reason: string) => void;
  }
): Promise<number>;
export interface WebhookStatus {
  id: string;
  host: string;
  method: 'POST' | 'PUT';
  events: ('raised' | 'cleared')[];
  minSeverity: 'warning' | 'critical';
  pending: number;
  lastSuccessAt: number | null;
  lastFailure: { at: number; reason: string } | null;
}
export interface Notifications {
  enqueue(event: AlertEvent): void;
  status(): WebhookStatus[];
  stop(): Promise<void>;
}
export function startNotifications(
  db: PiPulseDb,
  options: {
    webhooks: WebhookConfig[];
    hostname: string;
    metrics: MetricLabel[];
    log?: (message: string) => void;
    now?: () => number;
    intervalMs?: number;
    actions?: AlertAction[]; // tests; default createWebhookAction per webhook
  }
): Notifications;
```

- [ ] **Step 1: Write the failing tests** for `sendDue` with fake actions and a controllable clock (no real timers):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { headOf, insertNotification, webhookStats } from '../src/outbox.js';
import { GIVE_UP_AFTER_MS, retryDelay, sendDue, startNotifications } from '../src/sender.js';
import type { AlertAction } from '../src/action.js';

let db: PiPulseDb;
let now: number;
beforeEach(() => {
  db = openDb(':memory:');
  now = 1_000_000;
});
afterEach(() => db.close());

const add = (webhookId: string, event: 'raised' | 'cleared' = 'raised', at = now) =>
  insertNotification(db, {
    webhookId,
    alertId: 1,
    event,
    ruleId: 'r',
    metric: 'm',
    payload: `{"e":"${event}"}`,
    nextAt: at,
    createdAt: at
  });
const action = (
  id: string,
  results: (true | string | 'hang')[]
): AlertAction & { sent: string[] } => {
  const sent: string[] = [];
  return {
    id,
    apiVersion: 1,
    sent,
    async deliver(payload, signal) {
      const result = results.shift() ?? true;
      if (result === 'hang')
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('timeout')))
        );
      if (result !== true) throw new Error(result);
      sent.push(payload);
    }
  };
};
const run = (actions: AlertAction[], onGiveUp?: (id: string, n: number, reason: string) => void) =>
  sendDue(
    db,
    actions.map((a) => ({ action: a, timeoutMs: 50 })),
    { now: () => now, ...(onGiveUp ? { onGiveUp } : {}) }
  );

describe('sendDue', () => {
  it('backs off 5 s, 10 s, … up to 5 min', () => {
    expect([1, 2, 3, 7, 20].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 300_000, 300_000]);
  });

  it('sends in order per webhook: a later row waits behind a failing one', async () => {
    add('a');
    add('a', 'cleared');
    const a = action('a', ['HTTP 503', true, true]);
    expect(await run([a])).toBe(0);
    expect(headOf(db, 'a')).toMatchObject({
      event: 'raised',
      attempts: 1,
      nextAt: now + 5_000,
      lastError: 'HTTP 503'
    });
    expect(await run([a])).toBe(0); // not due yet
    now += 5_000;
    expect(await run([a])).toBe(1);
    expect(await run([a])).toBe(1);
    expect(a.sent).toEqual(['{"e":"raised"}', '{"e":"cleared"}']);
  });

  it('keeps webhooks independent, even when one hangs', async () => {
    add('slow');
    add('fast');
    const slow = action('slow', ['hang']);
    const fast = action('fast', [true]);
    expect(await run([slow, fast])).toBe(1);
    expect(fast.sent).toHaveLength(1);
    expect(headOf(db, 'slow')).toMatchObject({ attempts: 1, lastError: 'timeout' });
  });

  it('gives up after 6 hours with one callback', async () => {
    add('a');
    const giveUps: unknown[] = [];
    const a = action('a', Array(100).fill('HTTP 500'));
    now += GIVE_UP_AFTER_MS;
    await run([a], (...args) => giveUps.push(args));
    expect(giveUps).toEqual([['a', 1, 'HTTP 500']]);
    expect(headOf(db, 'a')).toBeUndefined();
    expect(webhookStats(db, 'a').lastFailure).toMatchObject({ reason: 'HTTP 500' });
  });

  it('pulls a far-future retry in to 5 minutes after the clock jumps back', async () => {
    add('a');
    const a = action('a', ['HTTP 500', true]);
    await run([a]); // next_at = now + 5 s
    now -= 3 * 60 * 60_000; // clock jumps back 3 h
    await run([a]); // next_at is > 5 min ahead: pulled to now + 5 min
    expect(headOf(db, 'a')!.nextAt).toBe(now + 5 * 60_000);
    now += 5 * 60_000;
    expect(await run([a])).toBe(1);
  });
});

describe('startNotifications', () => {
  it('fails rows of removed webhooks at start and reports status without the URL', async () => {
    add('gone');
    const n = startNotifications(db, {
      webhooks: [
        {
          id: 'apprise',
          url: 'https://u:p@apprise.lan:8000/notify/key?x=1',
          method: 'POST',
          headers: { A: 'b' },
          events: ['raised'],
          minSeverity: 'critical',
          timeoutMs: 1000
        }
      ],
      hostname: 'Io',
      metrics: [],
      now: () => now,
      intervalMs: 1e9,
      actions: [action('apprise', [])]
    });
    expect(webhookStats(db, 'gone').lastFailure).toMatchObject({ reason: 'webhook removed' });
    const status = n.status();
    expect(status).toEqual([
      {
        id: 'apprise',
        host: 'apprise.lan:8000',
        method: 'POST',
        events: ['raised'],
        minSeverity: 'critical',
        pending: 0,
        lastSuccessAt: null,
        lastFailure: null
      }
    ]);
    expect(JSON.stringify(status)).not.toMatch(/notify\/key|u:p|x=1/);
    await n.stop();
  });

  it('wakes on enqueue and delivers', async () => {
    const a = action('apprise', [true]);
    const n = startNotifications(db, {
      webhooks: [
        {
          id: 'apprise',
          url: 'http://x',
          method: 'POST',
          headers: {},
          events: ['raised', 'cleared'],
          minSeverity: 'warning',
          timeoutMs: 1000
        }
      ],
      hostname: 'Io',
      metrics: [],
      intervalMs: 1e9,
      actions: [a]
    });
    const { raiseAlert } = await import('@pipulse/alerts');
    n.enqueue({
      type: 'raised',
      alert: raiseAlert(db, {
        ruleId: 'r',
        metric: 'm',
        severity: 'warning',
        message: 'M',
        value: 1,
        raisedAt: Date.now()
      })
    });
    await vi.waitFor(() => expect(a.sent).toHaveLength(1));
    await n.stop();
  });
});
```

Also test pruning: rows sent 8 days ago are deleted on the first loop run (drive it with `startNotifications` and a `now` 8 days after `sent_at`, then `await n.stop()` and count rows).

- [ ] **Step 2: Implement `sender.ts`**

```ts
export function retryDelay(attempts: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

export async function sendDue(db, actions, options): Promise<number> {
  const results = await Promise.all(
    actions.map(async ({ action, timeoutMs }) => {
      const row = headOf(db, action.id);
      if (!row) return 0;
      const t = options.now();
      // The Pi has no RTC: after the clock jumps back, a retry could sit hours
      // away. Never wait longer than the longest retry delay.
      if (row.nextAt - t > MAX_RETRY_MS) {
        setNextAt(db, row.id, t + MAX_RETRY_MS);
        return 0;
      }
      if (row.nextAt > t) return 0;
      try {
        await action.deliver(row.payload, AbortSignal.timeout(timeoutMs));
        markSent(db, row.id, options.now());
        return 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const at = options.now();
        if (at - row.createdAt >= GIVE_UP_AFTER_MS) {
          markGivenUp(db, row.id, at, reason);
          options.onGiveUp?.(action.id, row.attempts + 1, reason);
        } else {
          markAttemptFailed(db, row.id, at, reason, at + retryDelay(row.attempts + 1));
        }
        return 0;
      }
    })
  );
  return results.reduce((a, b) => a + b, 0);
}
```

`startNotifications`:

- builds `actions` (given, or `createWebhookAction(w)` per webhook) paired with each webhook's `timeoutMs`;
- calls `failRemovedWebhooks(db, webhooks.map((w) => w.id), now())` once;
- `enqueue` = `createEnqueuer(db, { …, onQueued: wake, onError: (e) => log(\`notification queueing failed: ${message}\`) })`;
- a loop: `let running: Promise<void> | undefined`, `wake()` starts `running = drain()` unless already running (then sets `again = true`); `drain()` repeats `sendDue` while it returns > 0 or `again` was set, and prunes (`pruneNotifications(db, now() - PRUNE_AFTER_MS)`) when an hour has passed since the last prune (and on the first run); errors from `sendDue` are logged with `log`, never thrown; `onGiveUp` logs `` `webhook ${id}: gave up after ${n} attempts (last: ${reason})` ``;
- `setInterval(wake, intervalMs ?? 5000)` and one immediate `wake()`;
- `stop()` clears the interval, sets a `stopped` flag that ends `drain`, and awaits `running`;
- `status()` maps each webhook to `WebhookStatus` with `host: urlHost(w.url)` and `webhookStats(db, w.id)`.

With no webhooks, `startNotifications` still returns a working object (enqueue no-op, status `[]`, no interval).

Add `export * from './sender.js';` to `index.ts`.

- [ ] **Step 3: Run and commit**

```bash
git add packages/notify
git commit -m "Deliver queued notifications with backoff, in order per webhook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: API status route, server wiring and `notify-test`

**Files:**

- Create: `packages/api/src/notify-routes.ts`, `packages/api/src/notify-test.ts`
- Modify: `packages/api/src/index.ts`, `packages/api/src/server.ts`, `packages/api/package.json` (dependency `"@pipulse/notify": "*"`), run `npm install`
- Test: `packages/api/test/notify-routes.test.ts`, `packages/api/test/notify-test.test.ts`

**Interfaces:**

- Consumes: `startNotifications`, `Notifications`, `WebhookStatus`, `readNotifyFile`, `parseNotifyConfig`, `NotifyConfigError`, `createWebhookAction`, `renderPayload`, `WebhookConfig` from `@pipulse/notify`.
- Produces: `ServerOptions.notify?: { status(): WebhookStatus[] }`; `GET /api/notify`.

- [ ] **Step 1: Failing route tests** (`packages/api/test/notify-routes.test.ts`):
  - no `notify` option → `GET /api/notify` answers `200 []`;
  - with a fake `notify: { status: () => [statusFor('https://user:pass@apprise.lan:8000/notify/key?x=1')] }` built with the real `startNotifications` on an in-memory db (so the host is computed by production code) → body equals the status array and `JSON.stringify(res.json())` doesn't match `/user|pass|notify\/key|x=1/`;
  - with `auth: { passwordHash, protectReads: true }` and no session → `401` (copy the hash setup from `packages/api/test/settings-routes.test.ts`).

- [ ] **Step 2: Implement** `notify-routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { WebhookStatus } from '@pipulse/notify';

/** Read-only webhook status for the Settings page; never the URL beyond its host, never headers. */
export function registerNotifyRoutes(
  app: FastifyInstance,
  notify: { status(): WebhookStatus[] } | undefined
): void {
  app.get('/api/notify', async () => notify?.status() ?? []);
}
```

In `index.ts`: `notify?: { status(): WebhookStatus[] }` on `ServerOptions` (doc comment: "Webhook delivery status, served read-only at /api/notify."), and `registerNotifyRoutes(app, options.notify);` next to the alert routes. Auth stays in the hook (a GET: public unless read protection).

- [ ] **Step 3: Wire `server.ts`**

After the rule source and before `buildServer`:

```ts
/** Webhooks from PIPULSE_NOTIFY_FILE, if set; a bad file stops startup with one line. */
function readWebhooks(): WebhookConfig[] {
  const path = process.env['PIPULSE_NOTIFY_FILE'];
  if (!path) return [];
  try {
    const file = readNotifyFile(path);
    if (file.worldReadable)
      console.warn('[pipulse] PIPULSE_NOTIFY_FILE is readable by other users; chmod 600 it');
    return parseNotifyConfig(file);
  } catch (error) {
    fail(error);
  }
}
// Queues a message per alert raise/clear for each webhook and delivers it
// in order, retrying for up to 6 h; survives restarts through the outbox.
const notifications = startNotifications(db, {
  webhooks: readWebhooks(),
  hostname: hostname(),
  metrics: builtinPlugins.map(({ id, label, unit }) => ({ id, label, unit })),
  log: (message) => console.warn(`[pipulse] ${message}`)
});
```

(`hostname` from `node:os`.) Pass `notify: notifications` to `buildServer`. Change the engine's `onChange` to:

```ts
  onChange: (event) => {
    alertFeed.publish(event);
    notifications.enqueue(event);
  },
```

In `shutdown()`, stop notifications before closing the db: `await notifications.stop()` alongside `app.close()` / `scheduler.stop()` (add it to the `Promise.all`).

- [ ] **Step 4: `notify-test` command** (`packages/api/src/notify-test.ts`):

```ts
import { hostname } from 'node:os';
import {
  createWebhookAction,
  parseNotifyConfig,
  readNotifyFile,
  renderPayload
} from '@pipulse/notify';
import type { Alert } from '@pipulse/alerts';

/**
 * Sends a test message to each webhook in PIPULSE_NOTIFY_FILE (or the one
 * named) directly, not through the outbox, and prints the outcome:
 *   node packages/api/dist/notify-test.js [webhook-id]
 * Exits 1 if any send failed or the file is invalid, 2 if the variable is unset.
 */
const path = process.env['PIPULSE_NOTIFY_FILE'];
if (!path) {
  console.error('PIPULSE_NOTIFY_FILE is not set');
  process.exit(2);
}
let webhooks;
try {
  webhooks = parseNotifyConfig(readNotifyFile(path));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const only = process.argv[2];
const chosen = only ? webhooks.filter((w) => w.id === only) : webhooks;
if (chosen.length === 0) {
  console.error(only ? `no webhook "${only}" in ${path}` : `no webhooks in ${path}`);
  process.exit(1);
}
const sample: Alert = {
  id: 0,
  ruleId: 'test',
  metric: 'cpu_temperature',
  severity: 'warning',
  message: 'PiPulse test notification',
  value: 42,
  raisedAt: Date.now(),
  clearedAt: null,
  clearedBy: null,
  acknowledgedAt: null,
  ruleHash: null
};
const context = {
  hostname: hostname(),
  metrics: [{ id: 'cpu_temperature', label: 'CPU temperature', unit: '°C' }]
};
let failed = false;
for (const webhook of chosen) {
  try {
    await createWebhookAction(webhook).deliver(
      renderPayload(webhook.body, 'test', sample, context),
      AbortSignal.timeout(webhook.timeoutMs)
    );
    console.log(`${webhook.id}: delivered`);
  } catch (error) {
    failed = true;
    console.log(
      `${webhook.id}: failed (${error instanceof Error ? error.message : String(error)})`
    );
  }
}
process.exit(failed ? 1 : 0);
```

(`renderPayload`'s event parameter accepts `'test'`, which sets `event` to `test` and the default body's `type` to `info`.)

Test (`packages/api/test/notify-test.test.ts`): start a local HTTP server (200 for `/ok`, 500 for `/bad`), write a temp notify file with webhooks `ok` and `bad`, run the built command with `execFile(process.execPath, ['--disable-warning=ExperimentalWarning', <abs path to packages/api/dist/notify-test.js>, …], { env: { ...process.env, PIPULSE_NOTIFY_FILE } })` and assert: all → exit 1, stdout contains `ok: delivered` and `bad: failed (HTTP 500)`; `ok` only → exit 0; the `ok` receiver got a JSON body with `type: 'info'` and `title` containing `PiPulse test notification`; unset variable → exit 2. The test depends on `npm run build` having run (as other api tests do for dist).

- [ ] **Step 5: Smoke-run and commit**

`npm run build`, `npm test`, lint, prettier. Then locally: start a tiny receiver (`node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(b);s.end()})}).listen(9911)"` in the background), a notify file with `{"webhooks":[{"id":"local","url":"http://127.0.0.1:9911/"}]}` (chmod 600) and run `PIPULSE_NOTIFY_FILE=… node packages/api/dist/notify-test.js` → `local: delivered` and the receiver prints the JSON. Stop both; clean up temp files. Record the output in the report.

```bash
git add packages/api package-lock.json
git commit -m "Wire notifications into the server, serve their status, add notify-test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Notifications section on the Settings page

**Files:**

- Create: `packages/web/src/notifications.tsx`
- Modify: `packages/web/src/settings-page.tsx`, `packages/web/src/types.ts`, `packages/web/src/styles.css`
- Test: `packages/web/test/notifications.test.tsx`, `packages/web/test/settings-page.test.tsx` (fetch stub by URL)

**Interfaces:**

- Produces (types.ts): `WebhookStatus` (same shape as the API's); `NotificationsSection()` (no props; fetches `/api/notify` with `getJson`).

- [ ] **Step 1: Failing tests** (`packages/web/test/notifications.test.tsx`, happy-dom, stub `fetch` by URL):
  - two webhooks: `apprise` (host `apprise.lan:8000`, raised and cleared, warning and up, last success 10:42, no failure, 0 pending) and `ntfy` (raised only, critical only, last success 09:00, last failure 10:40 `timeout`, 3 pending) → rows show id, host, "raised and cleared, warning and up" / "raised only, critical only", "Last delivered …", "Last failed … (timeout)", "3 waiting"; the `ntfy` row has a warning `StatusIcon` and the word "Failing" (its failure is newer than its success); `apprise` has neither;
  - `[]` → "No webhooks configured — set PIPULSE_NOTIFY_FILE.";
  - a failed fetch → "Couldn't load the notification status from the PiPulse server.";
  - a response that isn't an array (older server) → the empty state.
    Use `formatDateTime` from `format.ts` for times (the same helper the Alerts page uses) and assert with the same helper so the test is time-zone independent.

In `packages/web/test/settings-page.test.tsx`, make the `fetch` stub answer `/api/notify` with `[]` and everything else as today; keep all existing assertions.

- [ ] **Step 2: Implement** `notifications.tsx`: a `<section aria-labelledby="settings-notifications">` with `<h2 id="settings-notifications">Notifications</h2>`, a note "Webhooks are set in the file named by PIPULSE_NOTIFY_FILE; test one with `node packages/api/dist/notify-test.js`.", and a `<ul class="webhook-list">` of rows. Filters in words: events joined with " and " + " only" when one event ("raised only"); severity "warning and up" / "critical only". Render it in `settings-page.tsx` after the Storage section, inside the same page wrapper, outside the retention form (it loads independently; a failure there never affects the retention editor). Styles: reuse `.rule-list li` rules for `.webhook-list li` (extend the selector) and `.rule-source` colour for the host.

- [ ] **Step 3: Run and commit**

```bash
git add packages/web
git commit -m "Show webhook delivery status on the Settings page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs

**Files:**

- Modify: `README.md` (configuration: `PIPULSE_NOTIFY_FILE` with the Apprise and ntfy examples from the spec, `chmod 600`, `notify-test`; roadmap 5b-3 🚧 In progress), `docs/PLAN.md` (5b-3 row: in progress, what is built), `CLAUDE.md` ("Next up" says 5b-3 is implemented on branch `phase-5b-3-notify` awaiting its Pi exit criterion; build order line gains `notify`; one convention bullet: "Notifications: webhooks come only from `PIPULSE_NOTIFY_FILE` (never the API); URLs beyond the host and headers are never logged, served or shown; the outbox is migration 7")

- [ ] **Step 1:** Make the edits in each document's existing tone; don't mark 5b-3 done.
- [ ] **Step 2:** `npm run format` clean on the changed files, `npm run lint`, `npm test`.
- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md docs/PLAN.md
git commit -m "Document notifications and PIPULSE_NOTIFY_FILE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks

Run the spec's exit criterion on the Pi 2 (port 8889) with a notify file pointing at Apprise; capture `/api/notify` and `/api/alerts?state=all` before deleting the scratch database; record the result in `CLAUDE.md`, `README.md` and `docs/PLAN.md`; open the PR.
