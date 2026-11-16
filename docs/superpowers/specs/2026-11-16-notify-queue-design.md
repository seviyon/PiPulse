# Notification queue hardening — design

Status: approved (2026-11-16). Branch `notify-queue-hardening`. Follows the 2026-10-20 security review (open item: "the notify queue").

## Intent

A misconfigured, down or flapping webhook must not (a) keep newer alerts for the same endpoint waiting for hours, (b) make the outbox grow without a stated bound, or (c) flood the receiver with a stale replay when it comes back. The operator must be able to see, in PiPulse itself, that delivery is failing and what was suppressed.

Today (`packages/notify`): one delivery lane per webhook (other webhooks are never held up); strictly in order within a webhook; any failure retries on 5 s → 5 min for 6 h; redirects are deliberately not followed; `Retry-After` is ignored; pending rows are unbounded; recovery drains the whole backlog at once.

## Goals

- Classify failures as permanent, retryable, or retryable with `Retry-After`, and treat each accordingly.
- A permanently rejecting endpoint never holds newer alerts for itself for hours.
- A stated bound on pending rows per webhook, and a recovery that sends a bounded summary plus the alerts that are open now, not a replay.
- Suppressed, dropped and rejected counts are stored and shown (`/api/notify`, Settings), not only logged.
- Compaction is atomic and restart-safe.

## Non-goals / anti-goals

- No exactly-once delivery. Delivery stays **at-least-once**; a crash between a successful request and `markSent` can duplicate a message.
- No guarantee that a receiver sees a complete raise/clear lifecycle. Lifecycle preservation is **best-effort**: rows that may have been delivered are never coalesced, but a permanent rejection or an exhausted retry can still leave the receiver without a raise or a clear.
- No following of redirects (stays a security choice; a redirect is reported as a permanent error).
- No in-app alert for failing webhooks in this change (follow-up; it would also reach the operator through the other webhooks).
- No change to what a healthy webhook receives.

## Approaches considered

1. Classification, `Retry-After` and counters only. Small, but a recovery still replays every message.
2. **Chosen:** recovery summary plus current state, with a stated queue bound and atomic compaction.
3. Full history, paced and capped. Hides nothing, but a long flap still floods the receiver, and a cap forces drops anyway.

## Design

### Failure classes (`action.ts`, `sender.ts`)

| Class       | Statuses / errors                               | Behaviour                                                                         |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Permanent   | 3xx; 4xx except 408, 425, 429                   | Row is marked `failed` at once (reason kept). Webhook enters **needs attention**. |
| Retryable   | 408, 425, 429, 5xx, timeout, network error      | Current ladder, 5 s → 5 min; gives up 6 h after the row was created, as today.    |
| Retry-After | 429, 503 with the header (seconds or HTTP date) | Next try = max(ladder delay, header), capped at 15 min.                           |

`deliver()` rejects with a typed error carrying `kind` (`permanent` / `retryable`) and an optional `retryAfterMs`, so the sender doesn't parse reason strings.

**Two schedules, one precedence rule.** A retryable failure schedules only the _row_: `row.next_at` = ladder delay or `Retry-After` (capped 15 min), exactly as for a healthy webhook. A permanent rejection sets the _webhook's_ `needs_attention` and `next_probe_at`. An attempt is allowed when `now >= row.next_at` **and** (`needs_attention` is off **or** `now >= next_probe_at`). The two never shorten each other: a short `Retry-After` still waits for a probe slot while needs attention is on; a probe slot never makes a row retry before its own `next_at`. `needs_attention` clears only on an **HTTP response** that is not permanent: a success, or a retryable status such as 503 or 429 (the endpoint answered and is no longer rejecting outright). A **transport failure** (timeout, connection refused, DNS, TLS) says nothing about whether the endpoint still rejects requests, so it neither sets nor clears the state: `needs_attention` and the reason stay as they are, the row follows its own ladder, and the probe gate stays in force. The gate is consumed by **every attempt made while `needs_attention` is set**, whatever its outcome: the attempt sets `next_probe_at = now + 5 min` before it runs, so repeated transport failures can never retry faster than one attempt per 5 minutes (and never earlier than the row's own `next_at`).

**`needs_attention` and `degraded_since` are different things.**

- `needs_attention` (+ `next_probe_at`, `reason`): set only by a permanent rejection. It controls **pacing** and the **Settings warning** ("Needs attention: HTTP 401, check URL and credentials").
- `degraded_since`: set on the first failed attempt of any kind, cleared when a delivery succeeds and the queue is then empty. It controls **when compaction runs** and shows as a quieter Settings line ("Delivery delayed since …").

**Needs attention (pacing):** while it is set, the lane may attempt a delivery only when `now >= webhook_state.next_probe_at`, and every attempt made while it is set (permanent, transport or otherwise) sets `next_probe_at = now + 5 min`, written before the request so a crash mid-attempt doesn't allow an immediate retry. So a dead endpoint costs at most one `failed` row per 5 minutes however many rows are queued or arrive. The gate lives in the sender, not in `enqueue.ts` (new rows still queue as due immediately), and `next_probe_at` is persisted, so it holds across restarts and an idle queue: a row that arrives long after the last probe is attempted at once (the 5 minutes have passed), and one that arrives within them waits. The state clears by the rule above (a non-permanent HTTP response), not only on success. Settings shows the reason, for example "HTTP 401: check URL and credentials". The webhook file is read only at startup, so a permanent error from our own config cannot fix itself without a restart; a receiver-side fix (a 404 until a service exists) is picked up by the probes.

**Wall-clock jumps.** Every persisted time (row `created_at`/`next_at`, and in `webhook_state` `degraded_since`, `next_probe_at`, `last_summary_at`) moves with a jump, in the same statement set as today's `shiftPending`. `next_probe_at` is also clamped like `next_at`: never more than 5 minutes ahead of now. The 5-minute eligibility age is measured on the shifted `created_at`.

### Possibly delivered rows

Migration 8 adds `notifications.started_at` and `notifications.failed_kind` (`rejected` | `abandoned`, set when a row becomes `failed` for those reasons; both nullable). The sender sets it **before** each request and never clears it. A pending row with `started_at` set is **possibly delivered**. This is deliberately conservative:

- A crash after setting it but before the request also marks the row possibly delivered.
- A row that got 429, 5xx, a timeout or a network error stays possibly delivered for good (the receiver may have processed it).
- A permanent response (3xx, 4xx) is **treated as** "the receiver did not accept it", but that is an assumption, not proof: a server can process a request and then answer with an error or a redirect. The row becomes `failed` (`failed_kind = 'rejected'`), and, because `started_at` is set, its lifecycle partner is protected like any other started row. We accept that this can send a clear for an alert the receiver never saw; receivers generally ignore that, whereas dropping it could leave one holding an alert open.
- A retryable row that runs out of its 6 hours is `failed` with `failed_kind = 'abandoned'`, keeps its `started_at`, and its partner is protected the same way.

**One rule for compaction:** a raise **keeps its clear** whenever its `started_at` is set, whatever its outcome (`sent`, `rejected`, `abandoned`, or the pending head). Only raises that were never started can be coalesced with their clears.

Because delivery is in order per webhook, at most one pending row per webhook is possibly delivered (the head).

### Compaction

Per webhook, in one `BEGIN IMMEDIATE` transaction (restart-safe: a crash leaves the old state or the new one, never dropped rows without their summary and counters):

Eligible rows are never-started (`started_at` null). Decisions use the **`alerts` table**, not row pairing, so webhooks that subscribe to only `raised` or only `cleared` are handled the same way.

1. **Dropped as transient:** a never-started `raised` row whose alert is now cleared and whose own `cleared` row (if the webhook gets one) is never-started. Both rows are deleted and counted as _opened and cleared_.
2. **Kept:** `raised` rows of alerts still open; the possibly-delivered head, and the partner clear of a possibly-delivered raise; `cleared` rows whose raise has `started_at` set (sent, rejected, abandoned, or the possibly-delivered head), because the receiver may know that alert and must hear it ended.
   **Cleared-only webhooks** (no `raised` in `events`) never get raises, so there is no lifecycle to protect: their never-started `cleared` rows are **summarized and deleted** (counted as _cleared_), subject to rule 3. **Raised-only webhooks** have no clear rows: an unsent raise of an alert now cleared is dropped and counted as _opened and cleared_.
3. Rows younger than 5 minutes (**`ELIGIBLE_AFTER_MS`**) are not coalesced, so a short blip stays lossless, unless the queue is over the cap (below), when age no longer protects them.
4. The webhook's single unstarted pending **summary** row is created or its counts merged (a started summary is left alone and a new one is made), and the counters are updated, all in the same transaction.

**Bound.** Let _P_ be the number of distinct (rule, metric) pairs in force (an alert is open per pair at most once; the schema's unique index on open alerts enforces this). After any compaction a webhook has at most: open-alert raises (≤ _P_) + `cleared` rows of every started raise (sent, rejected or abandoned) + the possibly-delivered head and its partner (2) + 1 summary.

Why the clears kept for known raises are ≤ _P_, not one per historical episode. **Invariant:** rows are created in event order and a webhook finishes a row before it starts the next, so the **completed** rows (`sent` or `failed`, of either kind) form a prefix of that webhook's alert rows in id order. Deleting rows from the middle (compaction) keeps the remaining completed rows a prefix; the summary is not an alert row and doesn't count. Every started raise is in that prefix (or is the head). A clear still pending whose raise is in the prefix, of whatever outcome, belongs to an alert that was **open at the moment the prefix ended** (its raise was queued, its clear not yet). At any instant at most one alert per pair is open, so there are at most _P_ such alerts. Earlier episodes of the same pair have both rows after the prefix and are coalesced like any other unsent pair. So the retained set is ≤ **2 × _P_ + 3**, and the burst after the summary is at most that many rows. A randomized test (seeded) drives sequences of raise, clear, successful delivery, outage, permanent rejection, retry exhaustion, restart and clock jump, across all three subscription shapes, checks the completed-prefix invariant after every step and fails if a compaction leaves more than that. The test covers clears of sent, rejected and abandoned raises. If it ever finds a counter-example, the fallback is to fold such clears older than 24 h into the summary too.

**What the bound is, once the 5-minute protection is counted.** Rows younger than 5 minutes are kept unless the queue is over the cap, so the 2 × _P_ + 3 figure holds for a compaction that finds the queue **over the cap** (100 pending alert rows). A compaction that finds the queue at or below the cap keeps at most what it found, which is at most 100. So after any compaction the pending alert rows are at most **max(100, 2 × _P_ + 3)**, and at most 2 × _P_ + 3 whenever the cap was exceeded. The cap is not a hard limit: retained classes are kept even above it.

**When it runs.** A persistent per-webhook state row (`webhook_state`, migration 8: `degraded_since`, `needs_attention`, `next_probe_at`, `reason`, lifetime counters `opened_and_cleared`, `cleared`, `rejected`, `abandoned`, `dropped` and `last_summary_at`), plus a table of **unsummarized per-rule counts** (`webhook_id`, `kind` = `opened_and_cleared` | `cleared` | `rejected` | `abandoned` | `dropped`, `rule_id`, `n`), which replaces any flat "unsummarized" counter. Whatever removes or fails a row (compaction deleting it, a row becoming `rejected` or `abandoned`, a cap drop) increments the lifetime counter **and** the per-rule row for that row's `rule_id` in the same transaction, so the rule ids are never lost when the row is deleted. Compaction folds the per-rule rows into the summary payload (top 10 rules, then "and N more") and deletes them in the same transaction as the summary insert. The lifetime counters are totals only and are never used to build text. **What persists and what clears:** the row and its lifetime counters persist for as long as the webhook is configured (a removed webhook's row is deleted with its notifications). Each flag has its own rule: `degraded_since` is set on the first failed attempt and cleared only when a delivery succeeds and the queue is then empty; `needs_attention`, `reason` and `next_probe_at` are set by a permanent rejection and cleared by a non-permanent HTTP response (see "Two schedules"), which may come before any delivery has succeeded. The unsummarized counters clear only when compaction turns them into a summary. While `degraded_since` is set, compaction runs **before every attempt**, including the first attempt after recovery, and at startup before the lanes start. Compaction also runs when pending exceeds the cap. A recently queued, under-cap backlog after a permanent-error period is therefore still compacted before it can drain.

**While the endpoint rejects requests outright** (`needs_attention` set), compaction still deletes rows and keeps counting, but queues no summary: it would be rejected too and its counts spent. The first compaction after the endpoint answers again makes one summary with everything. The degraded period also stays open while counts are unreported, so a success that empties the queue still leads to that summary. A rule edit that closed an alert and reopened it unchanged leaves the first alert's unsent raise in place when the reopened alert has none of its own (the enqueuer leaves it out on purpose), so compaction never counts it as an alert that ended.

**The probe.** A webhook in needs attention with nothing queued has no row to try the endpoint with, yet its counts would wait for the next alert. So, when it has counts held, it is tried with the recovery summary itself (built from the counts, which stay where they are) once per probe slot (`next_probe_at`, taken before anything else, even before the summary is rendered, like for a row). The counts are spent, and needs attention and the degraded flag cleared, only when the endpoint accepts it. Any failure keeps waiting for the next slot: a permanent refusal updates the reason; a status that can be retried (503, 429) moves the slot out by its `Retry-After` (never less than a slot, never more than 15 minutes); a transport failure leaves it as it was. A probe is not a notification: a refusal of it is counted nowhere and queues nothing. A waiting row is always the probe and goes first.

**Order.** The head query orders: possibly-delivered rows first, then the summary, then the rest by id. So the summary always goes out before the remaining backlog drains.

### Recovery summary

A new internal event `summary`. It is not a value of the webhook `events` filter (which stays `raised`, `cleared`); a webhook receives a summary only if, since its last summary, any of its own rows were coalesced (deleting rows as _opened and cleared_, or, for a cleared-only webhook, as _cleared_, each increments its counter and triggers a summary), `rejected`, `abandoned` or dropped at the cap (so any one of those alone triggers a summary), and those were its subscribed rows, so its `events` and `minSeverity` filters already applied. Each of those events increments, in the same transaction, both a lifetime counter and an **unsummarized** counter in `webhook_state`; compaction (which runs before every attempt while degraded, and at startup) turns the unsummarized counts into the summary row and zeroes them. If the last event is an abandoned row and nothing else ever arrives, the summary waits for the next event; the counters show on Settings meanwhile.

**No recursive summaries.** A summary row that itself fails (`rejected`, or `abandoned` after 6 h) increments **no** counter and triggers no summary. It is still delivered, retried and gated like any row, and a permanent rejection of it still sets `needs_attention` (that is information about the endpoint). Its content is not re-queued: the lifetime counters on Settings keep the counts, and the next summary, made only from new events, regenerates "open now" from the `alerts` table. Summary rows are also excluded from coalescing, from the cap count, and from the bound's open-alert and clear terms (they are the "+1"). Bounded by construction: a summary is created only from new events, never from a summary's own failure.

Content, bounded to about 1 KB and at most 10 rules listed, then "and N more":

- alerts opened and cleared while delivery was unavailable (rule ids and counts);
- for a cleared-only webhook, alerts that cleared while delivery was unavailable (rule ids and counts; the `cleared` counter);
- alerts open now, taken from the `alerts` table for this webhook's `minSeverity` (and only if it subscribes to `raised`);
- how many notifications were rejected (permanent), abandoned (retried for 6 h) or dropped at the cap.

Rendering: a webhook without a `body` gets the Apprise-shaped default ("`{{hostname}}`: notifications were delayed", body line is the summary text, `type` the highest severity involved). A webhook with a custom `body` renders it with `event` = `summary`, `message` = the summary text, `severity` = highest involved, `raisedAt`/`clearedAt` = the outage window, `hostname`, and the alert-specific placeholders (`ruleId`, `metric`, `metricLabel`, `value`, `rawValue`, `duration`, `clearedBy`) empty or null. An optional per-webhook `summaryBody` replaces this rendering for custom templates where that makes no sense. `docs/alerts.md` documents the table. (My call: `summaryBody`.)

### Visibility

`GET /api/notify` and Settings → Notifications show per webhook: needs attention and its reason, `degraded_since`, lifetime counts of opened-and-cleared, cleared, rejected, abandoned and dropped, and `last_summary_at`. A warning appears on Settings while a webhook is degraded. The existing log lines stay.

## Tests

- A delivered raise, then its clear queued during an outage: the clear is kept and sent after recovery.
- A possibly-delivered raise (started, then a timeout) with its clear: neither is coalesced.
- A crash after `started_at` is set, then restart: the row is treated as possibly delivered.
- Permanent rejection (401, 404, a redirect): the row is `failed` at once, newer rows are tried at the 5-minute pace, recovery sends the summary with open alerts from the `alerts` table.
- A recent under-cap backlog after a permanent-error period: compacted before the first attempt, summary sent first.
- A short blip (rows under 5 minutes old): nothing coalesced.
- The cap: over 100 pending with open alerts and delivered-raise clears, the retained set stays within the stated bound.
- A crash and restart around summary creation and around summary delivery: no dropped rows without a summary; no duplicate summary.
- `Retry-After` in seconds and as a date, capped at 15 min, ignored on other statuses.
- A webhook that subscribes to `raised` only: an unsent raise of a now-cleared alert is dropped and counted; one that subscribes to `cleared` only: its eligible never-started clears are summarized and deleted, and clears younger than 5 minutes are kept (unless over the cap).
- Schedules: a 503 with `Retry-After: 20` during needs attention waits for both the row's `next_at` and the next probe slot, and clears needs attention once it answers 503; a 429 at `Retry-After: 10 min` is not retried earlier by a probe slot; a transient failure alone (no needs attention) retries on the 5 s ladder, not after 5 minutes.
- Exhaustion: a row abandoned after 6 h keeps protecting its partner clear, is counted as `abandoned` in the summary and on Settings, and alone triggers a summary at the next compaction.
- A rejected raise (401) whose clear is pending: the clear is kept and sent after recovery (assumption documented: the receiver may have processed it).
- A transport error (timeout, refused) while needs attention is set: the state stays set and the probe gate still applies; a 503 clears it.
- Repeated transport failures after a probe: with needs attention set and the row's ladder allowing a retry every few seconds, attempts are still at least 5 minutes apart (each attempt advances `next_probe_at`), including across a restart mid-attempt.
- Cleared-only deletion: discarding eligible clears increments `cleared` and produces a summary.
- A webhook's unsummarized per-rule counts survive a restart and produce exactly one summary naming the right rules and counts; a crash between deleting rows and inserting the summary leaves both or neither; more than 10 rules show "and N more" with a correct remainder.
- A summary that is rejected (401) and one that is abandoned after 6 h: neither increments a counter, neither triggers another summary, the next one comes only from new events; a rejected summary still sets needs attention.
- A cleared-only webhook's discarded clears raise the `cleared` counter and appear in its summary text.
- State persistence: lifetime counters survive a restart; `needs_attention` clears on a 503 before any success; `degraded_since` stays until a success with an empty queue.
- Pacing: with needs attention set, a new row arriving within 5 minutes of the last probe is not attempted early; the same after a restart; with an empty queue then a later row (attempted at once, since 5 minutes have passed).
- Clock jumps (forward and back) with needs attention and a persisted `next_probe_at`, and across the 5-minute eligibility age.
- The seeded random test of the bound (2 × _P_ + 3).
- Custom `body` rendering of a summary, and `summaryBody`.
- Mutation run on the changed `packages/notify` lines; survivors killed or argued equivalent.

## Left to the builder

Migration 8's exact schema (including whether `event` needs a table rebuild to allow `summary`, and what `alert_id` holds on a summary row); the exact summary wording; the `webhook_state` column names; Settings layout; the precise head-ordering SQL.
