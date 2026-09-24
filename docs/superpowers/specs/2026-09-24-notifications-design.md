# Phase 5b-3 — Notifications: design

Status: approved in brainstorming on 2026-09-24; this document is for review before the implementation plan.

Last of the three 5b pieces: 5b-1 added sign-in and settings, 5b-2 made alert rules editable in the browser, and this one tells someone who isn't looking at the dashboard.

## Goal

When an alert is raised or clears, PiPulse sends a message to one or more webhooks the operator configured in a file, such as their Apprise instance, and keeps trying until it's delivered or clearly can't be:

- Any receiver can be targeted. Each webhook has a JSON body template; without one, the body is what Apprise's `/notify` endpoint expects.
- A receiver that is down for a while (restarting, homelab box off, Wi-Fi drop) doesn't lose messages. Deliveries survive a PiPulse restart and arrive in order.
- Webhooks are defined only in an operator-owned file. Nothing reachable through the API can add a destination or trigger a request.
- Secrets in URLs and headers never appear in logs, the API or the dashboard.

**Success:** see [Exit criterion](#exit-criterion).

## Scope

In scope: a new workspace package `packages/notify` (config file, templates, outbox store, sender, the versioned `AlertAction` interface); migration 7 (`notifications` table); wiring into the engine's `onChange` in `server.ts`; `GET /api/notify`; a read-only Notifications section on the Settings page; a `notify-test` command.

Out of scope:

- Repeat reminders for an alert that stays open (`resendEvery` in `docs/PLAN.md`).
- Shell or email actions, browser notifications, sound.
- Editing webhooks in the browser, or a "Send test" button: both would let an API client trigger outbound requests, which `docs/PLAN.md` rules out.
- Silencing an alert for a period.

## Configuration

`PIPULSE_NOTIFY_FILE` (optional) points at a JSON file:

```json
{
  "webhooks": [
    { "id": "apprise", "url": "http://apprise.lan:8000/notify/pipulse" },
    {
      "id": "ntfy",
      "url": "https://ntfy.sh/my-pi",
      "headers": { "Authorization": "Bearer tk_…" },
      "body": {
        "topic": "my-pi",
        "title": "{{severity}}: {{message}}",
        "message": "{{metricLabel}} = {{value}} since {{raisedAt}}"
      },
      "events": ["raised"],
      "minSeverity": "critical"
    }
  ]
}
```

| Field         | Required | Meaning                                                                                              |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Unique, lowercase snake_case. Shown in logs and on the Settings page.                                |
| `url`         | yes      | `http://` or `https://`.                                                                             |
| `method`      | no       | `POST` (default) or `PUT`.                                                                           |
| `headers`     | no       | Map of header name to string value, e.g. `Authorization`. `Content-Type: application/json` is added. |
| `body`        | no       | A JSON template (below). Default: Apprise's shape, see [Default body](#default-body).                |
| `events`      | no       | Which events to send: `raised`, `cleared`. Default both.                                             |
| `minSeverity` | no       | `warning` (default) or `critical`: skip alerts below it.                                             |
| `timeout`     | no       | Duration for one request, `1s`–`60s`. Default `10s`.                                                 |

The file is read once at startup. Any problem stops startup with one line naming the webhook and field, the same policy as the rules file: invalid JSON, an unknown field, a duplicate `id`, a bad URL or method, an unknown placeholder, a bad duration. Editing the file takes effect on restart.

Startup logs a warning when the file is readable by other users (it usually holds secrets): `PIPULSE_NOTIFY_FILE is readable by other users; chmod 600 it`.

### Templates

A `body` is any JSON value. Placeholders `{{name}}` are replaced only inside string values, and the result is serialized, so an alert message containing quotes or braces can't break the JSON. There are no conditionals or loops.

A string that is exactly one placeholder (`"{{rawValue}}"`) takes that field's JSON type, so a number stays a number; placeholders inside a longer string render as text. Unknown placeholders are refused at startup. A field with no value (e.g. `clearedAt` on a raise) renders as `""`, or `null` when it is the whole string.

| Placeholder   | Value                                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `event`       | `raised`, `cleared` or `test`                                                    |
| `ruleId`      | The rule's id                                                                    |
| `metric`      | The plugin id, e.g. `cpu_temperature`                                            |
| `metricLabel` | The plugin label, e.g. `CPU temperature`                                         |
| `severity`    | `warning` or `critical`                                                          |
| `message`     | The rule's message, e.g. `CPU running hot`                                       |
| `value`       | The reading that raised it with its unit, rounded to one decimal, e.g. `82.4 °C` |
| `rawValue`    | The same reading as a number (`null` for a silence alert)                        |
| `raisedAt`    | Local time the alert was raised, e.g. `2026-09-24 10:42`                         |
| `clearedAt`   | Local time it cleared (empty on a raise)                                         |
| `duration`    | How long it was open, e.g. `12 min` (empty on a raise)                           |
| `clearedBy`   | `condition` or `rule_changed` (empty on a raise)                                 |
| `hostname`    | The Pi's hostname                                                                |

### Default body

A webhook without `body` gets:

```json
{
  "title": "{{hostname}}: {{message}}",
  "body": "{{metricLabel}} {{value}} ({{severity}}, {{event}})",
  "type": "…"
}
```

with `type` set per event for Apprise: `warning` for a warning raise, `failure` for a critical raise, `success` for a clear, `info` for a test. Pointing a webhook at Apprise's `/notify/<key>` needs nothing else.

## Which events notify

The engine's `onChange` reports every raise and clear. Notifications are sent for:

- every **raise**, except the immediate re-raise that follows editing a rule when its severity and message are unchanged;
- a **clear** with `clearedBy: 'condition'`;
- a **clear** with `clearedBy: 'rule_changed'` when the edited rule does not re-raise (the alert is over under the new rule).

Not sent: acknowledgements, and clears with `clearedBy: 'rule_removed'` (the operator removed or disabled the rule themselves).

**Pairing an edit's close and reopen.** Since 5b-2, editing a rule closes its open alert as `rule_changed` and, if the edited rule still holds, reopens it in the same engine check with the same timestamp. So a `rule_changed` clear is queued as a "cleared" row that isn't due for 30 s. When a raise for the same rule and metric arrives with `raisedAt` equal to that clear's `clearedAt`, the pending clear row is deleted, and a "raised" is queued only if the severity or message differs from the alert that closed. With no re-raise, the "cleared" goes out after 30 s.

Filters (`events`, `minSeverity`) apply per webhook; a cleared event uses the severity of the alert that cleared.

## Outbox

Migration 7:

```sql
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  alert_id   INTEGER NOT NULL,
  event      TEXT NOT NULL,     -- 'raised' | 'cleared'
  rule_id    TEXT NOT NULL,     -- for pairing an edit's clear and re-raise
  metric     TEXT NOT NULL,
  payload    TEXT NOT NULL,     -- the rendered body, frozen at the event
  status     TEXT NOT NULL,     -- 'pending' | 'sent' | 'failed'
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,  -- when the next attempt is due
  last_error TEXT,              -- short reason, never the URL
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_notifications_queue ON notifications(webhook_id, status, id);
```

- `enqueue(event)` runs synchronously in `onChange`, right after the engine wrote the alert row: it applies the rules above and the filters, renders the payload per webhook, and inserts one row per matching webhook.
- The payload is rendered at enqueue time, so values are those at the event and a template edited later doesn't rewrite queued messages.
- Rows are pruned 7 days after they were sent or failed (checked hourly).

## Sender

A loop in the server process (`startNotifier`), started next to the engine and stopped on shutdown, the same pattern as housekeeping:

- It wakes on each enqueue and at least every 5 s.
- Per webhook, one request at a time: it sends that webhook's oldest pending row whose `next_at` has passed. Later rows for the same webhook wait behind it, so a "cleared" never arrives before its "raised". Webhooks don't wait for each other.
- Any 2xx response marks the row `sent`. Anything else is a failed attempt: a non-2xx status, a timeout, a network error, or a 3xx (redirects are not followed, so a URL can't send the Pi elsewhere). At most 1 KB of a response is read, and only to classify it.
- Retry delay: 5 s after the first failure, doubling, capped at 5 min.
- After 6 h of failures since the row was created, it is marked `failed` and logged once: `[pipulse] webhook apprise: gave up after 43 attempts (last: HTTP 503)`. Failures before that are not logged per attempt; the Settings page shows them.
- **Clock jumps.** The Pi has no RTC: a `next_at` more than 5 min in the future is treated as due in 5 min, so a clock jumping backwards can't stall the queue.
- **Restart.** Pending rows resume where they left off. At startup, pending rows for a webhook id no longer in the file are marked `failed` with `webhook removed`.
- A failing send is reported and never throws into the engine or the server.

## `AlertAction` interface

`docs/PLAN.md` asks for alert actions behind one narrow, versioned interface. `packages/notify` defines it and the webhook is its only implementation:

```ts
export const ALERT_ACTION_API_VERSION = 1;

export interface AlertAction {
  id: string;
  apiVersion: 1;
  /** Sends one rendered notification; resolves on success, rejects with a short reason. */
  deliver(payload: string, signal: AbortSignal): Promise<void>;
}
```

The outbox and sender know only this interface; the webhook action owns URL, method, headers, timeout and redirect handling. A later action type (e.g. a shell command from the file) would implement the same interface.

## API

- `GET /api/notify` — per webhook: `id`, `host` (the URL's host only), `method`, `events`, `minSeverity`, `pending` (count), `lastSuccessAt`, `lastFailure` (`{ at, reason }` or `null`). Never the URL, path, query or headers. It follows the same read-protection rule as other reads (`PIPULSE_PROTECT_READS`). With no file configured: `[]`.
- No write endpoints.

## Dashboard

A read-only **Notifications** section on the Settings page:

- One row per webhook: id, host, filters in words ("raised and cleared, warning and up"), "Last delivered 10:42", "Last failed 10:40 (timeout)" and "3 waiting". A failure newer than the last success is marked with an icon and words, never colour alone.
- With no webhooks: "No webhooks configured — set `PIPULSE_NOTIFY_FILE`."

## `notify-test` command

`node packages/api/dist/notify-test.js [webhook-id]` reads `PIPULSE_NOTIFY_FILE`, renders each webhook's body (or the one named) with a test event (`event: "test"`, sample alert fields, the real hostname), sends it directly (not through the outbox), and prints per webhook `apprise: HTTP 200` or `apprise: failed (timeout)`. It exits non-zero if any send failed. It's how the operator checks a URL or template before relying on it.

## Security

- Webhooks are defined only in the operator's file. No endpoint writes webhook config or triggers a send.
- URLs and headers are never logged, served or shown; logs and the API name the webhook id and URL host only.
- Redirects are not followed; response bodies are read up to 1 KB and never logged.
- Rendered payloads are stored in the database, so the database file deserves the same care as the notify file.
- Startup warns when the notify file is readable by other users.

## Testing

Vitest, in CI like every phase, with a local HTTP server as the receiver:

- **Config:** every validation error (unknown field, duplicate id, bad URL, bad method, unknown placeholder, bad timeout); defaults applied.
- **Templates:** placeholders only in strings; quotes and braces in a message stay valid JSON; a lone placeholder keeps its JSON type; missing values; the default Apprise body and its `type` per event.
- **Events:** filters by event and severity; `rule_removed` clears and acknowledgements send nothing; the `rule_changed` pairing (same severity and message → nothing, changed → "raised", no re-raise → "cleared" after 30 s).
- **Sender:** 2xx marks sent; non-2xx, timeout, connection refused and 3xx are failures with backoff 5 s → 10 s → … → 5 min; give up after 6 h with one log line; order per webhook (a later row waits); webhooks independent; resume after restart; rows for a removed webhook marked failed; the clock-jump guard; pruning after 7 days.
- **API:** `GET /api/notify` shape, no URL or header anywhere in the response, read protection.
- **Web:** the Settings section's rows, failure marking and the empty state.
- **Command:** `notify-test` against the local server, exit codes.

## Exit criterion

On the Pi 2 (port 8889), with `PIPULSE_NOTIFY_FILE` pointing at the operator's Apprise:

1. `notify-test` delivers a test message to the phone.
2. A `test_busy` rule (`cpu_load` at least 50 % for `1min`) under a `yes` load sends "raised"; after `pkill yes`, "cleared" arrives about a minute later.
3. With Apprise unreachable (stopped, or the URL's port changed and PiPulse restarted), a raise stays queued; restarting PiPulse while it is still unreachable doesn't lose it; once it is back, "raised" and then "cleared" arrive in that order within 5 minutes.
4. The Settings page shows the last delivery and the last failure.

Before deleting the scratch database, capture `/api/notify` and `/api/alerts?state=all`.

Plus `npm test`, lint and format green in CI.
