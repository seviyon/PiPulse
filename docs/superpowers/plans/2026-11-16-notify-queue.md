# Notification queue hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a failing, rejecting or flapping webhook bounded and visible: classified failures, a needs-attention probe gate, atomic compaction of a backlog into one recovery summary, and counters on Settings.

**Architecture:** The sender (`packages/notify/src/sender.ts`) keeps one lane per webhook and gains per-attempt classification, a persisted per-webhook state (`webhook_state`) and a `started_at` marker on rows. A new `compact.ts` coalesces never-started rows and queues one `summary` row in a single transaction before attempts while a webhook is degraded. `summary.ts` renders it through the webhook's own template.

**Tech Stack:** TypeScript, `node:sqlite` via `@pipulse/storage`, Vitest (`packages/notify/test`), Preact for the Settings section.

**Spec:** `docs/superpowers/specs/2026-11-16-notify-queue-design.md` (approved 2026-11-16). Read it first; where this plan names a spec section, that section is the authority.

## Global Constraints

- Node >=22.13; storage is `node:sqlite` (`DatabaseSync`). `packages/notify` imports only `@pipulse/storage` and `@pipulse/alerts` (`test/imports.test.ts` enforces it; `notify-test` must still never load SQLite, so `parseDuration` stays imported from `@pipulse/storage/duration`).
- Migrations append only: this change is **migration 8**; never edit migration 7. Recreate dev/test databases after changing an unshipped migration.
- Spec constants, verbatim: retry ladder 5 s → 5 min (`FIRST_RETRY_MS`, `MAX_RETRY_MS`); `Retry-After` honoured on 429 and 503, next try = max(ladder, header) capped at **15 min**; give up **6 h** after creation (`GIVE_UP_AFTER_MS`); probe interval **5 min**; `ELIGIBLE_AFTER_MS` **5 min**; `PENDING_CAP` **100**; summary at most **10 rules** then "and N more", text about **1 KB**; prune after 7 days.
- Permanent = 3xx and 4xx except 408, 425, 429. Retryable = 408, 425, 429, 5xx and transport errors. Redirects are never followed.
- Never log or serve a URL beyond its host, nor a header value; error reasons stay short strings.
- No pre/post npm hooks. After adding any file run the repo-wide `npm run lint`.
- Mutation run (`npm run mutate`, on a copy of the repo, never the working tree) on the changed `packages/notify` lines, survivors killed or argued equivalent in the PR; a fresh-context review comes before merge.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. No release label until the end (then `release:minor`).

## Review Focus

Inputs and conditions the spec implies but the main tests don't exercise; each has a test in the task that owns the code.

1. An `alerts` row that no longer exists (hand-deleted, or pruned) while notification rows still point at it: compaction treats it as cleared and never throws (Task 7).
2. A webhook removed from the file while it has pending rows, state, per-rule counts or a pending summary: rows fail as "webhook removed", state and counts are deleted, no orphan summary is ever sent (Task 8).
3. Garbage `Retry-After` (empty, `0`, negative, non-numeric, a date in the past, a year in seconds): ignored or capped, never a stall (Task 2).
4. Shutdown aborts a request in flight: the row stays possibly delivered, no counter moves, the probe slot is not refunded (Task 4).
5. Wall-clock jump forward or back with `degraded_since`, `next_probe_at`, pending rows and the 5-minute eligibility age: ages and gates move together, no mass-coalescing after a jump (Task 5).

---

## File Structure

- `packages/storage/src/migrations.ts` — migration 8 (Task 1).
- `packages/notify/src/action.ts` — `DeliveryError`, `classifyStatus`, `parseRetryAfter` (Task 2).
- `packages/notify/src/outbox.ts` — `started_at`/`failed_kind` on rows, head ordering, shift covers state (Tasks 3, 8).
- `packages/notify/src/state.ts` (new) — `webhook_state` and per-rule counts (Task 3).
- `packages/notify/src/sender.ts` — attempt flow, schedules, gate, flags (Tasks 4, 5, 8).
- `packages/notify/src/summary.ts` (new) — summary text and payload; `config.ts`/`template.ts` — `summaryBody` (Task 6).
- `packages/notify/src/compact.ts` (new) — compaction transaction (Task 7).
- `packages/api` and `packages/web/src/settings/notifications.tsx` — visibility (Task 9).
- `docs/alerts.md`, `CLAUDE.md` — docs (Task 10).

---

### Task 1: Migration 8

**Files:**
- Modify: `packages/storage/src/migrations.ts` (append after migration 7)
- Test: `packages/storage/test/migrations.test.ts` (follow its existing style)

**Interfaces:**
- Produces: `notifications.started_at INTEGER`, `notifications.failed_kind TEXT`; tables `webhook_state` and `webhook_summary_counts`; `SCHEMA_VERSION` 8.

- [ ] **Step 1: Write failing tests:** (a) a fresh database has `webhook_state` columns `webhook_id, degraded_since, needs_attention, reason, next_probe_at, opened_and_cleared, cleared, rejected, abandoned, dropped, last_summary_at` and `webhook_summary_counts(webhook_id, kind, rule_id, n)` with primary key `(webhook_id, kind, rule_id)`; (b) upgrading a version-7 database that holds a pending row with `attempts = 2`, a sent row, a given-up row (`status='failed'`, `attempts = 6`) and a never-tried pending row gives `started_at` set (to `COALESCE(sent_at, failed_at, created_at)`) on the first three and null on the last, and `failed_kind = 'abandoned'` only on the failed row with attempts.
- [ ] **Step 2: Run it and see it fail:** `npx vitest run packages/storage/test/migrations.test.ts` — FAIL (no such columns).
- [ ] **Step 3: Append migration 8.** DDL: `ALTER TABLE notifications ADD COLUMN started_at INTEGER; ALTER TABLE notifications ADD COLUMN failed_kind TEXT;` then `CREATE TABLE webhook_state (webhook_id TEXT PRIMARY KEY, degraded_since INTEGER, needs_attention INTEGER NOT NULL DEFAULT 0, reason TEXT, next_probe_at INTEGER, opened_and_cleared INTEGER NOT NULL DEFAULT 0, cleared INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, abandoned INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, last_summary_at INTEGER)` and `CREATE TABLE webhook_summary_counts (webhook_id TEXT NOT NULL, kind TEXT NOT NULL, rule_id TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (webhook_id, kind, rule_id))`; then `UPDATE notifications SET started_at = COALESCE(sent_at, failed_at, created_at) WHERE attempts > 0` and `UPDATE notifications SET failed_kind = 'abandoned' WHERE status = 'failed' AND attempts > 0`. A comment above it says why, like migration 7's.
- [ ] **Step 4: Run the storage tests** (`npm test --workspace=packages/storage`) — PASS.
- [ ] **Step 5: Commit** `feat(storage): migration 8 for notification state`.

---

### Task 2: Typed delivery errors, classification, Retry-After

**Files:**
- Modify: `packages/notify/src/action.ts`
- Test: `packages/notify/test/action.test.ts`

**Interfaces:**
- Produces: `type FailureKind = 'permanent' | 'retryable'`; `class DeliveryError extends Error { kind: FailureKind; transport: boolean; retryAfterMs: number | null }` (constructor `(message, { kind, transport, retryAfterMs? })`); `classifyStatus(status: number): 'ok' | FailureKind`; `parseRetryAfter(value: string | null, nowMs: number): number | null`; `MAX_RETRY_AFTER_MS = 15 * 60_000`.
- `AlertAction.deliver` still rejects with an `Error`; a `DeliveryError` is an `Error`, so `ALERT_ACTION_API_VERSION` stays 1 and a non-`DeliveryError` rejection is read as retryable transport.

- [ ] **Step 1: Write failing tests:** `classifyStatus` returns `'ok'` for 200–299, `'permanent'` for 301, 302, 400, 401, 403, 404, 410, `'retryable'` for 408, 425, 429, 500, 503. `parseRetryAfter('20', now)` is 20_000; a date 90 s ahead of `now` is about 90_000; null, `''`, `'0'`, `'-5'`, `'abc'`, a date in the past and `'1e9'` give null, 0-or-null as the spec's "ignored" (return null for all of these) except a huge but valid number, which is returned unclamped (the sender caps it). `createWebhookAction` against a fake `fetch`: a 401 rejects with `DeliveryError{kind:'permanent', transport:false}` and message `HTTP 401`; a 302 with message `redirect (HTTP 302)`; a 503 with `Retry-After: 20` rejects `{kind:'retryable', transport:false, retryAfterMs:20000}`; a `Retry-After` on a 500 is ignored (`retryAfterMs: null`); a thrown `fetch` (refused) rejects `{kind:'retryable', transport:true}` with the existing short reason.
- [ ] **Step 2: Run** `npx vitest run packages/notify/test/action.test.ts` — FAIL.
- [ ] **Step 3: Implement** the three exports and the class in `action.ts` and make `deliver` throw them. Only 429 and 503 read `Retry-After`. Keep the existing "never put the raw undici error in `cause`" rule.
- [ ] **Step 4: Run** the same file — PASS.
- [ ] **Step 5: Commit** `feat(notify): classify delivery failures and read Retry-After`.

---

### Task 3: Outbox columns, state store, shift

**Files:**
- Modify: `packages/notify/src/outbox.ts`; Create: `packages/notify/src/state.ts`; export it from `index.ts`
- Test: `packages/notify/test/outbox.test.ts`, `packages/notify/test/state.test.ts` (new)

**Interfaces:**
- Consumes: migration 8 (Task 1).
- Produces in `outbox.ts`: `OutboxRow` gains `startedAt: number | null` and `failedKind: 'rejected' | 'abandoned' | null`; `markStarted(db, id, at): void`; `markFailed(db, id, at, reason, kind: 'rejected' | 'abandoned'): void` (replaces `markGivenUp`, which is removed and its callers updated); `headOf` orders `started_at IS NULL, event <> 'summary', id` (started rows first, then a summary, then the rest); `shiftPending` also shifts `started_at` of pending rows and calls `shiftState`.
- Produces in `state.ts`: `type CountKind = 'opened_and_cleared' | 'cleared' | 'rejected' | 'abandoned' | 'dropped'`; `interface WebhookState { webhookId: string; degradedSince: number | null; needsAttention: boolean; reason: string | null; nextProbeAt: number | null; counts: Record<CountKind, number>; lastSummaryAt: number | null }`; `getState(db, webhookId): WebhookState` (defaults when no row); `setDegraded(db, id, at)` (only if null); `clearDegradedIfIdle(db, id)` (only when no pending row exists); `setNeedsAttention(db, id, reason, nextProbeAt)`; `clearNeedsAttention(db, id)`; `setNextProbeAt(db, id, at)`; `addCount(db, id, kind, ruleId, n = 1)` (lifetime column and the per-rule row, same statement set); `takeUnsummarized(db, id): { kind: CountKind; ruleId: string; n: number }[]` (reads then deletes); `hasUnsummarized(db, id): boolean`; `markSummary(db, id, at)`; `deleteStateExcept(db, keep: string[])` (state and per-rule counts of webhooks not in `keep`); `shiftState(db, ms)` (shifts `degraded_since`, `next_probe_at`, `last_summary_at` where set).

- [ ] **Step 1: Write failing tests:** `headOf` returns a started pending row before an older never-started one, and a `summary` row before later raises but after a started row; `markStarted` sets `started_at` and never clears it; `markFailed(..., 'rejected')` sets `status='failed'`, `failed_kind`, `last_error`; `addCount` adds to the lifetime column and the per-rule row, and a second call for the same rule adds `n`; `takeUnsummarized` returns and removes the rows; `clearDegradedIfIdle` does nothing while a pending row exists and clears when none; `shiftPending(db, 1000)` moves `created_at`, `next_at`, `started_at` of pending rows and the three state times, and leaves sent/failed rows alone.
- [ ] **Step 2: Run** `npx vitest run packages/notify/test/outbox.test.ts packages/notify/test/state.test.ts` — FAIL.
- [ ] **Step 3: Implement** the functions above; `getState` maps the integer flag to a boolean. Hooking `deleteStateExcept` into `failRemovedWebhooks` is Task 8, not here.
- [ ] **Step 4: Run** the two files and `npm test --workspace=packages/notify` — PASS (existing sender tests keep using the renamed function; update them).
- [ ] **Step 5: Commit** `feat(notify): started_at, failed_kind and webhook state store`.

---

### Task 4: Sender attempt flow and retry schedule

**Files:**
- Modify: `packages/notify/src/sender.ts`
- Test: `packages/notify/test/sender.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3. The test helper `action(id, results)` in `sender.test.ts` gains result values `{ kind: 'permanent' | 'retryable', transport?: boolean, retryAfterMs?: number }` that reject with a `DeliveryError`.
- Produces: constants `MAX_RETRY_AFTER_MS` (re-exported from `action.ts`) and `PROBE_INTERVAL_MS = 5 * 60_000`; `sendNext` behaviour below. Signatures of `sendNext`, `sendDue`, `startNotifications` are unchanged.

- [ ] **Step 1: Write failing tests:** (a) `started_at` is set before `deliver` runs (assert inside the fake action's `deliver`); (b) a `retryable` HTTP failure sets `next_at = now + retryDelay(attempts)`; a 503 with `retryAfterMs: 20_000` and attempts 1 sets `next_at = now + 20_000`; one with `retryAfterMs: 3_600_000` sets `now + MAX_RETRY_AFTER_MS`; one with `retryAfterMs: 2_000` still uses the 5 s ladder (max of the two); (c) a `permanent` failure marks the row `failed` with `failed_kind = 'rejected'` at once, increments `rejected` (lifetime and per-rule) and calls no give-up log; (d) a retryable row 6 h old becomes `failed_kind = 'abandoned'` and increments `abandoned`; (e) neither (c) nor (d) increments anything for a row with `event = 'summary'`; (f) **Review Focus 4:** a `stopSignal` abort mid-request leaves `started_at` set, `attempts` unchanged, `rejected`/`abandoned` unchanged; (g) the existing "next_at more than MAX_RETRY_MS ahead is clamped" test now clamps at `MAX_RETRY_AFTER_MS`.
- [ ] **Step 2: Run** `npx vitest run packages/notify/test/sender.test.ts` — FAIL.
- [ ] **Step 3: Implement.** In `sendNext`: call `markStarted(db, row.id, t)` immediately before `deliver`; read the error as `DeliveryError` (anything else is retryable transport); retryable → `markAttemptFailed` with `nextAt = at + min(max(retryDelay(n), retryAfterMs ?? 0), MAX_RETRY_AFTER_MS)`; permanent → `markFailed(..., 'rejected')` + `addCount(db, webhookId, 'rejected', row.ruleId)`; 6 h exhaustion → `markFailed(..., 'abandoned')` + `addCount(..., 'abandoned', ...)`; skip `addCount` when `row.event === 'summary'`. Replace the `MAX_RETRY_MS` clamp with `MAX_RETRY_AFTER_MS`.
- [ ] **Step 4: Run** the file — PASS.
- [ ] **Step 5: Commit** `feat(notify): classify failures, honour Retry-After, mark attempts`.

---

### Task 5: Needs-attention gate and degraded flag

**Files:**
- Modify: `packages/notify/src/sender.ts`
- Test: `packages/notify/test/sender.test.ts` (or `sender-gate.test.ts` if the file gets long)

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: the attempt rule "allowed when `now >= row.next_at` and (`needs_attention` off or `now >= next_probe_at`)"; no new exports.

- [ ] **Step 1: Write failing tests:** (a) a permanent failure sets `needs_attention`, `reason` (e.g. `HTTP 401`) and `next_probe_at = now + 5 min`, and `degraded_since = now`; (b) with it set, a new row arriving 1 min later is not attempted; at `+5 min` it is; (c) with it set, a **transport** failure keeps it set, and repeated transport failures with the row's ladder allowing 5 s retries are still at least 5 min apart (each attempt writes `next_probe_at = now + 5 min` **before** the request; assert the value from inside `deliver`); also after a simulated restart (new `startNotifications` on the same db) mid-attempt; (d) a 503 or 429 (HTTP, retryable) clears `needs_attention`; a success clears it; (e) `degraded_since` is set on the first failure of any kind, stays while rows are pending after a success, and clears only on a success with an empty queue; (f) a lane with an empty queue and `needs_attention` set attempts a later row at once when 5 min have passed; (g) **Review Focus 5:** `shiftPending` by +1 h and by −1 h with `next_probe_at`, `degraded_since` and pending rows keeps their relative ages, and `next_probe_at` more than 5 min ahead of now is pulled back to `now + 5 min`.
- [ ] **Step 2: Run** the file — FAIL.
- [ ] **Step 3: Implement** in `sendNext`: read `getState`; return false while gated; when `needsAttention`, `setNextProbeAt(t + PROBE_INTERVAL_MS)` in the same transaction as `markStarted`; set/clear per the spec's "Two schedules" paragraph (permanent → `setNeedsAttention` with the short reason; HTTP non-permanent response or success → `clearNeedsAttention`; transport → untouched); `setDegraded` on any failure; `clearDegradedIfIdle` after a success. Clamp `next_probe_at` like `next_at`.
- [ ] **Step 4: Run** the file and `npm test --workspace=packages/notify` — PASS.
- [ ] **Step 5: Commit** `feat(notify): probe gate for rejecting endpoints, degraded flag`.

---

### Task 6: Summary rendering and `summaryBody`

**Files:**
- Create: `packages/notify/src/summary.ts`; Modify: `packages/notify/src/config.ts`, `template.ts`
- Test: `packages/notify/test/summary.test.ts` (new), `config.test.ts`, `template.test.ts`

**Interfaces:**
- Produces: `interface SummaryInput { counts: { kind: CountKind; ruleId: string; n: number }[]; open: { ruleId: string; metric: string; severity: 'warning' | 'critical' }[]; since: number; now: number }`; `summaryText(input: SummaryInput, wants: { raised: boolean; cleared: boolean }): string` (at most about 1000 characters; at most 10 rules per kind line, then `and N more`); `renderSummary(webhook: WebhookConfig, input: SummaryInput, context: { hostname: string; metrics: MetricLabel[] }): string`. `WebhookConfig` gains `summaryBody?: unknown`. `PLACEHOLDERS` is unchanged; `event` takes the value `summary`.

- [ ] **Step 1: Write failing tests:** (a) `summaryText` names rules and counts per kind, e.g. `3 alerts opened and cleared: cpu_busy ×2, disk_full ×1`, `2 notifications could not be delivered`, `1 rejected`, `still open: swap_full (critical)`; "still open" is left out when `wants.raised` is false; for a cleared-only webhook the `cleared` kind appears; (b) 25 rules show 10 then `and 15 more`, and the text is at most 1000 characters even with 200-character rule ids (truncate ids); (c) `renderSummary` with no `body` returns the Apprise shape `{ title: '<hostname>: notifications were delayed', body: <text>, type }` with `type` `failure` if any critical alert is open, else `warning`; (d) with a custom `body`, placeholders render `event` = `summary`, `message` = the text, `severity` = highest involved, `raisedAt`/`clearedAt` = the outage window, `hostname`, and `ruleId`, `metric`, `metricLabel`, `value`, `rawValue`, `duration`, `clearedBy` empty or null; (e) `summaryBody` is used instead when present; (f) `config.test.ts`: `summaryBody` is parsed, template-checked like `body` (an unknown placeholder fails startup naming `summaryBody`), and omitted by default.
- [ ] **Step 2: Run** the three files — FAIL.
- [ ] **Step 3: Implement** `summary.ts`; extend `config.ts` parsing and the allowed-key list; extend `template.ts`'s `fieldsFor`-style field builder with a `fieldsForSummary` (do not widen `fieldsFor`'s alert-based signature).
- [ ] **Step 4: Run** the three files — PASS.
- [ ] **Step 5: Commit** `feat(notify): recovery summary text and payload`.

---

### Task 7: Compaction

**Files:**
- Create: `packages/notify/src/compact.ts`; export from `index.ts`
- Test: `packages/notify/test/compact.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 3 and 6.
- Produces: `ELIGIBLE_AFTER_MS = 5 * 60_000`, `PENDING_CAP = 100`; `compact(db: PiPulseDb, webhook: WebhookConfig, context: { now: number; hostname: string; metrics: MetricLabel[] }): { coalesced: number; summaryQueued: boolean }`. One `BEGIN IMMEDIATE` transaction per call.

- [ ] **Step 1: Write failing tests**, each building rows with `insertNotification` and alerts in the `alerts` table:
  - (a) never-started `raised` + `cleared` of a cleared alert, raise older than 5 min: both deleted, per-rule `opened_and_cleared` counted, one summary row queued; rows under 5 min old are kept (short blip); over `PENDING_CAP` pending, young rows are coalesced too.
  - (b) kept: a `raised` of a still-open alert; the started head and its partner clear; a `cleared` whose raise is `sent`, `rejected` or `abandoned` (any started raise) or the started head.
  - (c) cleared-only webhook: never-started clears are deleted, counted `cleared`, summarized; clears under 5 min are kept (unless over the cap). Raised-only: an unsent raise of a now-cleared alert is dropped and counted `opened_and_cleared`.
  - (d) a clear whose raise was `rejected`: kept (assumption in spec).
  - (e) the summary: one unstarted summary row is created, or merged into an existing unstarted one (counts add and the payload is re-rendered); a started summary is left alone and a new one is made; `takeUnsummarized` is empty afterwards; "still open" comes from the `alerts` table filtered by `minSeverity`.
  - (f) **atomicity:** with a fault injected after the deletes and before the summary insert (the test passes a throwing `now` getter or wraps `db.prepare`), nothing is deleted, no counts change and no summary exists; running again then succeeds.
  - (g) a second `compact` with nothing new queues no second summary; summary rows are never coalesced and never counted by the cap.
  - (h) **Review Focus 1:** an alert id missing from `alerts` is treated as cleared; no throw.
  - (i) compaction never touches another webhook's rows.
- [ ] **Step 2: Run** `npx vitest run packages/notify/test/compact.test.ts` — FAIL.
- [ ] **Step 3: Implement** per the spec's "Compaction" and "Recovery summary" sections: decide from the `alerts` table; find a clear's raise by `(webhook_id, alert_id, event = 'raised')`; "started" means `started_at IS NOT NULL`; each delete increments `addCount` in the same transaction; the summary row has `event = 'summary'`, `alert_id = 0`, `rule_id = ''`, `metric = ''`, `next_at = now`; call `markSummary`.
- [ ] **Step 4: Run** the file — PASS.
- [ ] **Step 5: Commit** `feat(notify): atomic compaction into a recovery summary`.

---

### Task 8: Wire compaction, ordering, removed webhooks

**Files:**
- Modify: `packages/notify/src/sender.ts` (`startNotifications` and the lane `drain`), `outbox.ts` (`failRemovedWebhooks`)
- Test: `packages/notify/test/sender.test.ts`, `outbox.test.ts`

**Interfaces:**
- Consumes: Tasks 3–7. `startNotifications` options unchanged; internally it builds, per webhook, a `prepare()` that runs `compact` when the webhook is degraded (`degraded_since` set) or pending exceeds `PENDING_CAP`, called **before every attempt** in the lane and once per webhook at startup before lanes start.

- [ ] **Step 1: Write failing tests:** (a) a recent under-cap backlog after a permanent-error period (needs attention, then the endpoint answers 200): compaction runs before the first attempt and the summary is delivered **before** the remaining rows (assert delivery order); (b) a restart (second `startNotifications` on the same db) with `degraded_since` set compacts at startup before any attempt; (c) a crash and restart between summary insert and delivery sends exactly one summary (the unsummarized counts are gone, `last_summary_at` set); (d) a healthy webhook (no `degraded_since`, under the cap) never compacts and sends in order; (e) **Review Focus 2:** a webhook removed from the file has its pending rows failed `webhook removed`, its `webhook_state` and per-rule counts deleted, and a pending summary row failed, never sent; (f) clock jump during an outage: no rows coalesced early or late (ages shift with the jump).
- [ ] **Step 2: Run** `npx vitest run packages/notify/test/sender.test.ts packages/notify/test/outbox.test.ts` — FAIL.
- [ ] **Step 3: Implement** the `prepare` call in `drain` (before each `sendNext`) and at startup, and make `failRemovedWebhooks` also call `deleteStateExcept`.
- [ ] **Step 4: Run** `npm test --workspace=packages/notify` — PASS.
- [ ] **Step 5: Commit** `feat(notify): compact a degraded webhook's queue before each attempt`.

---

### Task 9: Visibility on `/api/notify` and Settings

**Files:**
- Modify: `packages/notify/src/sender.ts` (`WebhookStatus`, `status()`), `packages/web/src/core/types.ts`, `packages/web/src/settings/notifications.tsx`
- Test: `packages/notify/test/sender.test.ts`, `packages/api/test/notify-routes.test.ts` (existing style), `packages/web/test/settings/notifications.test.tsx`, `e2e/` only if a notification spec already exists

**Interfaces:**
- Produces: `WebhookStatus` gains `needsAttention: { reason: string } | null`, `degradedSince: number | null`, `counts: { openedAndCleared: number; cleared: number; rejected: number; abandoned: number; dropped: number }`, `lastSummaryAt: number | null`. The API returns `status()` unchanged, so the route needs no logic.

- [ ] **Step 1: Write failing tests:** `status()` reports the new fields from state; the route returns them (host only, still no URL or header); the Settings section shows a warning line `Needs attention: HTTP 401, check URL and credentials` (with `StatusIcon`, words and not colour alone), a quieter `Delivery delayed since <time>` line, and the five lifetime counts and `last summary` when non-zero; an old server's body without the new fields still renders (treat missing as null/zero).
- [ ] **Step 2: Run** the three test files — FAIL.
- [ ] **Step 3: Implement** the fields and the section; follow the file's existing `StatusIcon` and `formatDateTime` use and the `module-layering` rules (import from `core/` only).
- [ ] **Step 4: Run** `npm test` for the three packages — PASS.
- [ ] **Step 5: Commit** `feat(notify): show attention, delay and suppressed counts on Settings`.

---

### Task 10: Bound test, docs, mutation, review

**Files:**
- Create: `packages/notify/test/bound.test.ts`
- Modify: `docs/alerts.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the randomized bound test** (seeded PRNG such as mulberry32, fixed seeds, at least 200 steps each for all three subscription shapes): random sequences of alert raise, alert clear, successful delivery, outage, permanent rejection, retry exhaustion (advance the clock 6 h), restart (new `startNotifications`) and clock jump. After every step assert the completed-prefix invariant (sent or failed rows form a prefix of the webhook's alert rows by id) and, after every `compact`, that pending alert rows are at most `2 × P + 3` for `P` the distinct (rule, metric) pairs used (plus summaries counted as the `+1`). Run it first and see a deliberately wrong bound (`P`) fail.
- [ ] **Step 2: Run** `npx vitest run packages/notify/test/bound.test.ts` — PASS with the real bound.
- [ ] **Step 3: Docs.** `docs/alerts.md`: the failure classes and `Retry-After`; at-least-once delivery and best-effort lifecycle; the recovery summary, its placeholder table and `summaryBody`; what Settings shows. `CLAUDE.md`: a short paragraph in the notifications section (migration 8, needs-attention gate, compaction, bound), and the open-issues list line for the notify queue marked done.
- [ ] **Step 4: Full checks:** `npm test`, `npm run lint`, `npm run format`, and `npm run test:e2e` if a notifications spec exists; coverage for the new files should match the package's.
- [ ] **Step 5: Mutation.** On a copy of the repo (`cp -cR`), `npm run mutate` for `sender.ts`, `compact.ts`, `state.ts`, `summary.ts` and the changed lines of `action.ts` and `outbox.ts`; kill or argue each survivor in the PR description.
- [ ] **Step 6: Commit** `docs(notify): queue hardening, bound test`; open the PR with `release:minor`, then ask for a fresh-context review of `compact.ts` and `sender.ts` before merging.

---

## Self-review

- **Spec coverage:** failure classes and `Retry-After` (2, 4); two schedules and the gate (5); possibly delivered rows and the one-rule `started_at` (1, 4, 7); compaction, cleared-only and raised-only, cap, age, atomicity, ordering (3, 7, 8); summary payload, `summaryBody`, filters (6); persistence and clearing rules, per-rule counts, no recursive summaries (3, 4, 7); visibility (9); clock jumps (3, 5, 8); bound and randomized test (10). Deliberately not implemented: the in-app `notify_failing` alert (spec non-goal).
- **Names:** `markFailed` replaces `markGivenUp` in Tasks 3 and 4; `PROBE_INTERVAL_MS`, `MAX_RETRY_AFTER_MS`, `ELIGIBLE_AFTER_MS`, `PENDING_CAP` are defined once (Tasks 4, 2, 7). `CountKind` is defined in `state.ts` and used by `summary.ts`.
- **Order:** each task's tests use only earlier tasks' interfaces; Task 6 precedes 7 because compaction renders the summary.
