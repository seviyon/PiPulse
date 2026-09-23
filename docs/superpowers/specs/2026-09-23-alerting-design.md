# Phase 5a — Alerting: design

Status: approved in brainstorming on 2026-09-23; this document is for review before the implementation plan.

Phase 5 in `docs/PLAN.md` is split in two, each with its own spec, plan and PR:

- **5a — Alerting (this document).** Rules with hysteresis, an engine that checks them, alert history, an API and dashboard views. No write endpoints, so no authentication.
- **5b — Settings (later).** Authentication, a `settings` table, the retention editor, and browser editing of alert rules (see [Deferred to 5b](#deferred-to-5b-settings)).

## Goal

PiPulse tells you, on the dashboard, when the Pi is in one of four sustained bad states, and when it has recovered:

1. **Overheating or throttling** — CPU temperature high for a while; the firmware reporting throttling or under-voltage.
2. **Storage filling** — `/` or `/boot` usage high.
3. **Sustained overload** — load above the core count, CPU busy, or heavy swapping, for many minutes rather than brief spikes.
4. **PiPulse stopped collecting** — a metric with no new reading for a while (a sensor or plugin broke).

"PiPulse itself is down" or "the Pi is off" cannot be detected from inside the Pi and is out of scope.

**Success:** a manufactured breach on the Pi raises an alert that appears live on the dashboard, survives a restart without duplicating, and clears after the condition has been normal for its clear window (see [Exit criterion](#exit-criterion)).

## Scope

In scope: rule model and built-in defaults, an optional rules file, the evaluation engine, the `alerts` table (migration 4), `GET /api/alerts`, rules in `/api/config`, live `alert` WebSocket messages, tile colouring driven by rules, a nav badge, an "Alert since" line on tiles, and an Alerts page.

Out of scope for 5a:

- **Outbound notifications** (webhook to Apprise, email, shell). The engine emits raise/clear events through a listener interface so a webhook action can be added later without touching the engine. `resendEvery` from `docs/PLAN.md` is dropped until there is something to resend to.
- **Anything that writes through the API**: editing rules in the browser, acknowledging or silencing alerts. These need authentication (5b).
- Browser notifications, sound, SNMP.

## Rule model

A rule is data, not code:

```json
{
  "id": "cpu_hot",
  "metric": "cpu_temperature",
  "atLeast": 80,
  "for": "2min",
  "clearAfter": "2min",
  "severity": "critical",
  "message": "CPU running hot"
}
```

| Field        | Required | Meaning                                                                                                                                                                  |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`         | yes      | Unique, lowercase snake_case. A file rule with a built-in's `id` replaces it.                                                                                            |
| `metric`     | yes      | A plugin id, or `"*"` (only for `noReadingFor`: applies to every plugin).                                                                                                |
| condition    | yes      | Exactly one of `atLeast`, `atMost` (number, inclusive), `bitsSet` (integer mask), `noReadingFor` (duration, or `"auto"`: 5 × the metric's poll interval, at least 2min). |
| `for`        | no       | How long the condition must hold before raising. Default `0s` (one reading). Not allowed with `noReadingFor`.                                                            |
| `clearAfter` | no       | How long the condition must be absent before clearing. Default: same as `for` (`0s` for `noReadingFor`).                                                                 |
| `severity`   | yes      | `warning` or `critical`.                                                                                                                                                 |
| `message`    | yes      | Plain words shown on the dashboard.                                                                                                                                      |
| `disabled`   | no       | `true` turns a rule (typically a built-in) off.                                                                                                                          |

**Durations** use the retention parser in `packages/storage/src/rollup.ts`, extended with `s` (seconds) and `min` (minutes): `30s`, `5min`, `2h`, `1d`. A bare `m` stays rejected (ambiguous between minutes and months). Retention variables accept the same grammar, so the UI in 5b validates both with one parser.

**Validation at startup.** The merged rule set is validated before the server listens. Any error stops startup with a message naming the rule and the problem, the same policy as the retention variables: an unknown `metric`, zero or several conditions, `for` or `clearAfter` longer than raw retention (the engine only reads raw data), `for` on a `noReadingFor` rule, a duplicate `id` within the file, a malformed duration, an unknown field.

### Rules file

`PIPULSE_ALERTS_FILE` (optional) points at a JSON file: `{ "rules": [ … ] }`. Its rules are merged over the built-ins by `id`: a new `id` adds a rule, an existing `id` replaces it, `"disabled": true` removes it. Editing the file takes effect on restart. The file is read-only to PiPulse and never writable through the API.

### Built-in defaults

| id                 | Metric            | Condition                                                 | For / clear | Severity |
| ------------------ | ----------------- | --------------------------------------------------------- | ----------- | -------- |
| `cpu_warm`         | `cpu_temperature` | ≥ 70 °C                                                   | 10min       | warning  |
| `cpu_hot`          | `cpu_temperature` | ≥ 80 °C                                                   | 2min        | critical |
| `throttled_now`    | `throttled`       | bits `0xf` (happening now)                                | 1min        | critical |
| `throttled_before` | `throttled`       | bits `0xf0000` (since boot)                               | 0s          | warning  |
| `disk_filling`     | `disk_used`       | ≥ 70 %                                                    | 10min       | warning  |
| `disk_full`        | `disk_used`       | ≥ 90 %                                                    | 10min       | critical |
| `boot_filling`     | `boot_used`       | ≥ 70 %                                                    | 10min       | warning  |
| `boot_full`        | `boot_used`       | ≥ 90 %                                                    | 10min       | critical |
| `load_queueing`    | `load_1`          | ≥ core count (detected at startup)                        | 15min       | warning  |
| `cpu_busy`         | `cpu_load`        | ≥ 90 %                                                    | 15min       | warning  |
| `swap_heavy`       | `swap_used`       | ≥ 80 %                                                    | 10min       | warning  |
| `swap_full`        | `swap_used`       | ≥ 95 %                                                    | 10min       | critical |
| `not_collecting`   | `*`               | `noReadingFor: "auto"` (5 × poll interval, at least 2min) | —           | warning  |

- The temperature defaults suit a Pi 5 with active cooling (the fan holds a busy Pi 5 around 55–65 °C, so 70 °C for 10 minutes means cooling isn't coping; throttling starts around 80–85 °C). They also suit the passively cooled Pi 2. The rules-file documentation includes an example for tuning them.
- `throttled_before` clears only when a reading no longer has the since-boot bits, i.e. after a reboot.
- There is no memory rule: `memory_used` is in MB and high use alone is normal on Linux; sustained swapping is the pressure signal and is covered.
- A rule for a metric that isn't collected on this host (e.g. `throttled` without `vcgencmd`) is kept but never raises, and `not_collecting` ignores a metric until it has a stored reading.

## Engine

New workspace package `packages/alerts`, built after `collector` and before `api` (build order: storage → collector → alerts → api → web).

- **Core (pure):** rule types, defaults, file parsing and validation, merge, and the decision "raise / clear / nothing" from a rule, its open alert (if any), and the facts a query returned. No `node:sqlite`, Fastify or Preact types.
- **Adapter:** runs the per-rule queries against `node:sqlite` and writes the `alerts` table.
- **Runner:** `startAlerts(db, rules, { onChange, intervalMs = 15000 })` runs every rule once at startup and then every `intervalMs`, returning `{ stop() }`; a failed check is reported and the next one still runs (the same pattern as `startHousekeeping`). The API server starts it next to the scheduler and housekeeping and stops it on shutdown.

### Checks

Every 15 s, per rule, one query over the metric's raw readings (primary-key range on `metrics (metric, ts)`):

| Condition            | Raise when, over the last `for`                                | Clear when, over the last `clearAfter`  |
| -------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `atLeast` / `atMost` | the lowest (highest) reading is still at or past the threshold | no reading was at or past the threshold |
| `bitsSet`            | every reading has at least one of the bits set                 | no reading has any of them              |
| `noReadingFor`       | the newest reading is older than the limit                     | a reading newer than the limit exists   |

- **Coverage.** A window counts only if readings cover it: the oldest reading in it is within 2 poll intervals of the window start, and the newest within 2 poll intervals of now. Otherwise the check decides nothing, neither raise nor clear. A server started a minute ago cannot claim "hot for 10 minutes", and a collection gap never clears an alert. For `for: 0s` the newest reading alone decides.
- **Hysteresis** comes from the two windows: a value bouncing across the threshold never holds for `for` and never stays away for `clearAfter`, so it neither raises nor clears repeatedly.
- **`noReadingFor`** watches only metrics with at least one stored raw reading, and counts silence from the later of the newest reading and server start. A restart therefore never raises it instantly, and a metric this host never collects (e.g. `throttled` without `vcgencmd`) is never flagged, while one that stops after having worked is.
- **Clock.** Windows use the Pi's clock, the same clock that stamps readings.

### Storage

Migration 4 adds:

```sql
CREATE TABLE alerts (
  id         INTEGER PRIMARY KEY,
  rule_id    TEXT NOT NULL,
  metric     TEXT NOT NULL,
  severity   TEXT NOT NULL,
  message    TEXT NOT NULL,
  value      REAL,            -- reading that raised it (NULL for noReadingFor)
  raised_at  INTEGER NOT NULL,
  cleared_at INTEGER,         -- NULL while open
  cleared_by TEXT             -- 'condition' | 'rule_removed'
);
CREATE UNIQUE INDEX idx_alerts_open ON alerts(rule_id, metric) WHERE cleared_at IS NULL;
CREATE INDEX idx_alerts_raised ON alerts(raised_at);
```

- At most one open alert per rule and metric (enforced by the partial unique index). A `*` rule is checked per metric, so two silent metrics are two alerts.
- After a restart open alerts stay open; the next check clears them only if the data says so.
- At startup, an open alert whose rule no longer exists (removed or disabled in the file) is closed with `cleared_by = 'rule_removed'`.
- Housekeeping deletes cleared alerts older than 1 year.
- `docs/PLAN.md`'s planned `settings` table becomes migration 5.

### Events

On raise or clear the runner calls `onChange({ type: 'raised' | 'cleared', alert })` after the row is written. The API publishes it over the WebSocket. This listener is the seam where a webhook action (to Apprise) plugs in later.

## API

All read-only:

- `GET /api/alerts?state=active|all&from=&to=&limit=` — alerts newest first; default `state=all`, last 30 days, `limit` 100 (max 1000). Each alert: `id`, `ruleId`, `metric`, `severity`, `message`, `value`, `raisedAt`, `clearedAt`, `clearedBy`.
- `GET /api/config` gains `rules`: the effective rules (after merge, disabled ones omitted), each with `source: 'built-in' | 'file'`, durations in ms, and the `load_queueing` threshold resolved to the core count.
- WebSocket `/api/live`: the `snapshot` message gains `alerts` (open alerts); raises and clears arrive as `{ type: 'alert', event: 'raised' | 'cleared', alert }`.

## Dashboard

Colour is never the only signal (icon and words), as today.

- **Tile colour from rules.** A tile's status is the highest severity among its metric's threshold rules (`atLeast`, `atMost`, `bitsSet`) whose condition holds for the current reading, ignoring `for`: tiles react to one reading, alerts to sustained ones. The thresholds in `packages/web/src/status.ts` are removed; its throttle-bit wording stays.
- **Alert line on tiles.** A tile with an open alert for its metric shows "Alert since 10:42 (12 min)".
- **Nav badge.** "Alerts ▲2" while alerts are open, with the count and the highest severity; plain "Alerts" otherwise.
- **Alerts page (`#/alerts`):**
  - _Open_ — severity, message, value at raise, since when, how long.
  - _Recent_ — cleared alerts from the last 30 days, with duration, and "rule removed" where that closed it.
  - _Rules_ — the effective rules, read-only, with their source (built-in or file), and a note that rules are edited in `PIPULSE_ALERTS_FILE` for now.
  - Each alert links to the History page at a range covering it.

## Security

- No endpoint in 5a writes anything, and rules come only from built-in code and an operator-owned file, in line with `docs/PLAN.md`'s "no arbitrary eval" and "alert actions operator-defined only".
- Alert reads expose about what metric reads already do. Today the Pi's ufw rule limits the port to the LAN.
- **Dependency on 5b:** authentication there must cover every write (settings, rule editing, acknowledging) and offer optional read protection (e.g. `PIPULSE_PROTECT_READS=true`) covering the dashboard, every `GET` and the WebSocket (which needs a cookie session or token handshake, since browsers can't send an auth header on a WebSocket).

## Testing

Vitest, in CI like every phase:

- **Core:** each condition raising and clearing; no decision before coverage; no flapping for a value bouncing across a threshold; `noReadingFor` counting from the later of newest reading and server start, and ignoring never-collected metrics; since-boot bits clearing only after a reboot; durations (`30s`, `5min`, bare `m` rejected); every validation error; file merge (add, replace, disable).
- **Adapter (in-memory SQLite):** migration 4; one open alert per rule and metric, two for a `*` rule with two silent metrics; open alerts surviving a restart; a removed rule's alert closed; pruning after a year; check queries using the primary-key index (`EXPLAIN QUERY PLAN`).
- **API:** `/api/alerts` filters and shape; `rules` in `/api/config`; the WebSocket snapshot with open alerts and live `alert` messages.
- **Web:** tile colours from rules (replacing the `status.ts` threshold tests); the tile alert line; the nav badge; the Alerts page's open, recent and rules sections.

## Exit criterion

On the Pi 2, with a rules file adding:

- `test_busy`: `cpu_load` ≥ 50 % for `1min`, clear after `1min`;
- `test_silent`: `disk_used` `noReadingFor` `30s` (it is polled every 60 s, so it goes briefly silent between readings).

1. Load the CPU (`yes > /dev/null` four times): within about 75 s `test_busy` opens, and the nav badge, tile line and Alerts page update live without a reload.
2. Restart PiPulse while it is open: still open afterwards, no duplicate row.
3. Stop the load: it clears about a minute later and moves to Recent.
4. `test_silent` raises and clears between `disk_used` readings.
5. Record the cost of the 15 s checks on the Pi 2 (per-check time with all rules).

Plus `npm test`, lint and format green in CI.

## Deferred to 5b (Settings)

- Authentication (writes always; reads optional, including the WebSocket).
- Editing, adding and disabling rules in the browser, stored in the database with the file and built-ins beneath it.
- Acknowledging or silencing an alert.
- The retention editor and `settings` table (migration 5), per `docs/PLAN.md`.
- Outbound notification actions (webhook to Apprise) may land in 5b or later, on the `onChange` seam.
