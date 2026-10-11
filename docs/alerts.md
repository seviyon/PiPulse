# Alerts and notifications

How alerts are raised and cleared, how to change the rules, and how to be notified. Settings that apply are in [Configuration](configuration.md).

PiPulse checks its alert rules every 15 seconds and shows open alerts on the dashboard: a badge on the Alerts link, a line on the affected tile, and the Alerts page (open, the last 30 days, and the rules in force). Tiles take their colours from the same rules, reacting to the current reading; alerts wait until a condition has lasted.

Built-in rules: CPU temperature ≥ 70 °C for 10 min (warning) or ≥ 80 °C for 2 min (critical); throttling or under-voltage now for 1 min (critical) or since boot (warning, clears after a reboot); `/` or `/boot` ≥ 70 % (warning) or ≥ 90 % (critical) for 10 min; load above the core count, CPU ≥ 90 %, swap traffic ≥ 250 pages/s (warning, "Swapping heavily" — pages moving to and from swap, not how full it is) or swap ≥ 95 % full (critical), each sustained; and any metric with no reading for 5 polls (at least 2 min).

To change them, point `PIPULSE_ALERTS_FILE` at a JSON file and restart. Entries are merged by `id`: a new id adds a rule, an existing one replaces it, `"disabled": true` removes it (disabling an id that doesn't exist is an error, so a typo can't silently leave a rule on). Each rule has exactly one condition — `atLeast`, `atMost`, `bitsSet` or `noReadingFor` — plus optional `for` and `clearAfter` durations (`30s`, `5min`, `2h`; no bare `m`). `for` and `clearAfter` can't be longer than `PIPULSE_RETENTION_RAW`, since those windows are read from raw readings; `noReadingFor` has no such limit. An invalid file stops PiPulse at startup with a message naming the problem.

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

Signed in, rules can be added, edited, disabled and reverted, and open alerts acknowledged, on the Alerts page; saved rules sit above `PIPULSE_ALERTS_FILE` and the built-ins and apply within 15 seconds, no restart needed.

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

```bash
PIPULSE_NOTIFY_FILE=~/pipulse-notify.json node packages/api/dist/notify-test.js [webhook-id]
```

It sends a test message to each webhook (or the one named) and prints `delivered` or why it failed.

If the receiver uses HTTPS with a certificate from your own certificate authority (a homelab CA, for example), Node doesn't trust it by default and every delivery fails with `network error (UNABLE_TO_VERIFY_LEAF_SIGNATURE)`. Give Node the CA certificate when starting PiPulse (and `notify-test`): `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
