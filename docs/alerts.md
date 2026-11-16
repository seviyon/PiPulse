# Alerts and notifications

How alerts are raised and cleared, how to change the rules, and how to be notified. Settings that apply are in [Configuration](configuration.md).

PiPulse checks its alert rules every 15 seconds and shows open alerts on the dashboard: a badge on the Alerts link, a line on the affected tile, and the Alerts page (open, the last 30 days, and the rules in force). Tiles take their colours from the same rules, reacting to the current reading; alerts wait until a condition has lasted.

Built-in rules: CPU temperature ≥ 70 °C for 10 min (warning) or ≥ 80 °C for 2 min (critical); throttling or under-voltage now for 1 min (critical) or since boot (warning, clears after a reboot); `/` or `/boot` ≥ 70 % (warning) or ≥ 90 % (critical) for 10 min; load above the core count, CPU ≥ 90 %, swap traffic ≥ 250 pages/s (warning, "Swapping heavily" — pages moving to and from swap, not how full it is) or swap ≥ 95 % full (critical), each sustained; and any metric with no reading for 5 polls (at least 2 min).

To change them, point `PIPULSE_ALERTS_FILE` at a JSON file and restart. Entries are merged by `id`: a new id adds a rule, an existing one replaces it, `"disabled": true` removes it (disabling an id that doesn't exist is an error, so a typo can't silently leave a rule on). Each rule has exactly one condition — `atLeast`, `atMost`, `bitsSet` or `noReadingFor` — plus optional `for` and `clearAfter` durations (`30s`, `5min`, `2h`; no bare `m`). `for` and `clearAfter` can't be longer than `PIPULSE_RETENTION_RAW`, since those windows are read from raw readings; `noReadingFor` has no such limit. A non-zero `for` or `clearAfter` can't be shorter than the time between readings of the metric it watches (for example 60 s for `disk_used`), because a window between two readings can never decide anything: use that time or more, or `0` to act on the latest reading. `bitsSet` is a mask from 1 to 4294967295 (32 bits). An invalid file stops PiPulse at startup with a message naming the problem.

```json
{
  "rules": [
    {
      "id": "cpu_warm",
      "metric": "cpu_temperature",
      "atLeast": 65,
      "for": "10min",
      "severity": "warning",
      "message": "CPU running warm"
    },
    { "id": "cpu_busy", "disabled": true },
    {
      "id": "disk_nearly_full",
      "metric": "disk_used",
      "atLeast": 95,
      "for": "5min",
      "severity": "critical",
      "message": "Disk nearly full"
    }
  ]
}
```

The temperature defaults suit a Pi 5 with an active cooler (it holds a busy Pi 5 around 55–65 °C) as well as a passively cooled Pi. For a hot enclosure, raise `cpu_warm`; for a fan you want to know about early, lower it.

Signed in, rules can be added, edited, disabled and reverted, and open alerts acknowledged, on the Alerts page (Disable asks for confirmation first, because it closes the rule's open alerts; Enable, Revert and Delete do not); saved rules sit above `PIPULSE_ALERTS_FILE` and the built-ins and apply within 15 seconds, no restart needed.

## Notifications

To be told when an alert opens or clears, point `PIPULSE_NOTIFY_FILE` at a JSON file of webhooks and restart:

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

Each webhook needs an `id` and an `http(s)` `url`; `method` (`POST` or `PUT`), `headers`, `body`, `events` (`raised`, `cleared`; default both), `minSeverity` (`warning` or `critical`) and `timeout` (`1s`–`60s`, default `10s`) are optional. Without a `body`, PiPulse sends what Apprise's `/notify` endpoint expects (a title, a body line, and a `type` of `warning`, `failure`, `success` or `info`), so an Apprise URL needs nothing else. A `body` is any JSON with `{{placeholders}}` in its strings — `event`, `ruleId`, `metric`, `metricLabel`, `severity`, `message`, `value`, `rawValue`, `raisedAt`, `clearedAt`, `duration`, `clearedBy`, `hostname` — and always stays valid JSON, whatever the alert message holds. An invalid file stops PiPulse at startup with a message naming the webhook and field.

A URL on a port `fetch` refuses to use (e.g. `:9`, `:25`) is also refused at startup, since every delivery to it would fail. So is a URL with a username or password (`https://user:pass@host/…`), which `fetch` refuses to send to: put the credential in an `Authorization` header instead.

The file usually holds secrets: keep other users out of it (`sudo chown root:pipulse /etc/pipulse/notify.json && sudo chmod 640 /etc/pipulse/notify.json` on an installed PiPulse, `chmod 600` when you run it as yourself; PiPulse warns at startup if other users can read it). Full URLs and headers are never logged, served or shown; the Settings page lists each webhook by host, with its last delivery, last failure and anything still waiting.

Messages are queued in the database and sent in order per webhook, retried with backoff (5 s, doubling, up to every 5 minutes) for up to 6 hours, and survive restarts. Removing or disabling a rule closes its alert without a message, and editing a rule so its alert closes and reopens unchanged sends nothing. To check a webhook without waiting for an alert:

### When a webhook fails

PiPulse sorts a failed delivery into one of three kinds:

- **The endpoint refuses outright** (a redirect, or a 4xx other than 408, 425 and 429, such as `401`, `403` or `404`). PiPulse never follows redirects. The row is marked failed at once and the webhook shows **Needs attention** on Settings with the reason. Until the endpoint answers differently it is tried only once every 5 minutes, so a wrong URL or token doesn't produce a stream of failures. The file is read only at startup, so fix it and restart; if the receiver was the problem (a `404` until a service exists), the next try finds out by itself.
- **Worth retrying** (408, 425, 429, any 5xx, a timeout or a refused connection): the usual backoff above. A `Retry-After` on a `429` or `503` is honoured when it is longer than the backoff, up to 15 minutes.
- **Success** (2xx).

Delivery is **at-least-once**: if PiPulse stops after the receiver got a message but before it recorded that, the message is sent again on restart, so a receiver may see a duplicate. PiPulse keeps a raise and its clear together as far as it can, but it can't promise a receiver ever sees both: a message the endpoint refused, or one still failing after 6 hours, is not delivered.

**Recovery summary.** While a webhook is failing, PiPulse tidies its queue before each try. An alert that opened and cleared while delivery was down is not worth replaying, so its two messages (queued at least 5 minutes ago, or any when more than 100 are waiting) are dropped and counted. Messages that may already have reached the receiver are never dropped, and neither is the raise of an alert that is still open or the clear of one the receiver knows about. When the endpoint works again it first gets **one summary**, then whatever remains: what opened and cleared meanwhile (rule ids and counts), what could not be delivered or was refused, and what is open now. A webhook that only subscribes to `cleared` gets the cleared alerts instead. The summary respects `events` and `minSeverity`. While an endpoint is rejecting requests, no summary is queued (it would be rejected too); the first one after it answers again carries the whole count. While an endpoint is rejecting requests, no summary is queued (it would be rejected too); the first one after it answers again carries the whole count.

A webhook with a `body` template renders the summary through that template with `event` set to `summary`, `message` holding the summary text, `severity` the highest severity involved, `raisedAt` and `clearedAt` the outage window, `hostname`, and `ruleId`, `metric`, `metricLabel`, `value`, `rawValue`, `duration` and `clearedBy` empty. If that makes no sense for your template, give the webhook a `summaryBody` (same placeholders, checked at startup) and it is used for summaries instead. Without a `body`, the Apprise default is sent with the title "notifications were delayed".

Settings → Notifications shows, per webhook, whether it needs attention, since when delivery has been delayed, how many messages were summarized, refused, abandoned or dropped, and when the last summary was sent. At most about `2 × (number of rules) + 3` messages per webhook wait after a tidy-up once the queue has grown past 100.

```bash
PIPULSE_NOTIFY_FILE=~/pipulse-notify.json node packages/api/dist/notify-test.js [webhook-id]
```

It sends a test message to each webhook (or the one named) and prints `delivered` or why it failed.

If the receiver uses HTTPS with a certificate from your own certificate authority (a homelab CA, for example), Node doesn't trust it by default and every delivery fails with `network error (UNABLE_TO_VERIFY_LEAF_SIGNATURE)`. Give Node the CA certificate when starting PiPulse (and `notify-test`): `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
