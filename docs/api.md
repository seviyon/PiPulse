# API

The REST and WebSocket endpoints the dashboard uses. Every write needs a signed-in session; see [Configuration](configuration.md#sign-in-and-settings).

Endpoints: `GET /api/health` (public; the body has `status` (`ok`, `degraded` or `failing`: `200` for ok and degraded, `503` for failing), `monitoring` (`ok` while the database answers and readings arrive), `transport`, `reasons` (why it isn't `ok`, e.g. `http-with-sign-in`) and `certificate`. An install that has a sign-in password but serves plain HTTP reports `degraded`, so a monitor should match `"monitoring":"ok"` rather than `"status":"ok"`), `GET /api/config` (PiPulse `version`, the running `node` and its end of support, device, including its CPU count, plugins (each with `unavailable` when it can't run here), the alert `rules` in force, and the server's `serverTime` and `uptimeMs`), `GET /api/metrics/latest`, `GET /api/metrics/:id/history?from=&to=` (raw samples, unix ms, default last hour), `GET /api/metrics/:id/series?from=&to=&resolution=` (avg/min/max points plus `count`, the raw samples each point stands for, default last 24 hours; `resolution` is `auto` (default), `raw`, `1m`, `1h` or `1d`, and `auto` picks the finest one that retention hasn't thinned in the range and that has at most ~1500 points there, so a new install's long ranges show the readings collected so far), `GET /api/alerts?state=&from=&to=&limit=` (`state` is `all` (default: open alerts plus any active during the window), `active`, or `cleared` (cleared during the window, newest cleared first); the window defaults to the last 30 days, newest raised first, up to `limit` (default 100, max 1000)), and `ws://…/api/live` (a `snapshot` of latest values and open `alerts` on connect, then one `sample` message per new reading and one `alert` message whenever an alert opens or clears), `GET /api/session` (`editable`, `signedIn`, `protectReads`), `POST /api/login` / `POST /api/logout`, and `GET /api/settings`, `POST /api/settings/preview`, `PUT /api/settings` (retention per level with its source, storage figures, what a change would delete, and saving it — a change that deletes data needs `confirmDeletion: true`), and `GET /api/notify` (each webhook's id, host, filters, queued count and last delivery or failure — never its full URL or headers), `GET /api/updates` (what `apt-get upgrade` would do: `state` is `ok` with the PiPulse installed and candidate versions and the packages that would be upgraded or kept back (up to 300 listed, `total` exact), `pending` before the first check, `failed` with one line, or `unsupported` in Docker or without apt; the server simulates the upgrade as its own unprivileged user two minutes after start and every 6 hours, and the package list says which packages are out of date, so `PIPULSE_PROTECT_READS=true` hides it) and `POST /api/updates/check` (signed in; re-reads now, at most once per 30 s). Every write needs a signed-in session; reads need one only with `PIPULSE_PROTECT_READS=true`. A fresh install speaks HTTPS and an upgraded one plain HTTP until you run `sudo pipulse tls enable` (see [HTTPS](https.md)); keep it on your LAN either way. If the host runs a firewall (e.g. ufw), open the port for your LAN only.

## Raw readings are capped

`GET /api/metrics/:id/history` and `series?resolution=raw` answer `400` when the window holds more than 5000 raw readings (about 7 hours at 5 s polling): the process reads and builds the whole answer without doing anything else, about 75 ms per 1000 readings on a Pi 2. Ask for a shorter window, or `resolution=1m`, `1h` or `1d`, or `auto` (the default), which picks one that fits. Rolled-up resolutions are not capped.

## Alert rules and acknowledging

Rules are the built-ins, then `PIPULSE_ALERTS_FILE`, then rules saved from the browser, merged by `id` (see [Alerts](alerts.md)). All writes need a session.

- `GET /api/alerts/rules`: one entry per rule id with its `kind` (`built-in`, `file`, `edited` or `added`), whether it is `disabled`, the rule in the rules-file format, whether something is `saved` for it, and a `problem` line when a saved entry is not in force.
- `POST /api/alerts/rules`: create a rule. `400` with `{ "errors": { "<field>": "…" } }` when it is invalid, `409` when the `id` is taken.
- `PUT /api/alerts/rules/:id`: save a rule (a body `id`, if present, must match). Saving over a built-in or file rule overrides it; a disabled rule stays disabled.
- `DELETE /api/alerts/rules/:id`: remove what was saved for that id, which reverts a built-in or file rule. `404` when nothing is saved.
- `POST /api/alerts/:id/acknowledge`: an acknowledged alert stays open but leaves the badge in the navigation until it clears. `404` for an unknown alert, `409` for one that has cleared.

A change applies at the engine's next check, within 15 seconds, and is pushed to open dashboards at once.

## Live feed

`ws://…/api/live` (`wss://` over HTTPS) sends a `snapshot` on connect (latest values and open alerts), then:

- `sample`: one per new reading,
- `alert`: whenever an alert opens, clears or is acknowledged,
- `rules`: the rules in force, after an edit.

The server accepts client frames of at most 1 KiB (it only needs pings). With `PIPULSE_PROTECT_READS=true` an unauthenticated socket is closed with code `4401`, and so is an open one when its session ends (at the next heartbeat).

## Responses

- Every response carries a `Content-Security-Policy` that allows only the dashboard's own files (`default-src 'none'`, scripts, styles, fonts and connections from `'self'`, `frame-ancestors 'none'`), plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Another page cannot frame the dashboard.
- `/api/*` answers `Cache-Control: no-store`.
- With `PIPULSE_ALLOWED_HOSTS` set (or `auto`), a request for any other host name gets `421` on every route, including the WebSocket upgrade; see [Configuration](configuration.md).
- A release built after 0.7.0 serves `/web-version.txt`, which says which dashboard build it ships. The dashboard warns above the navigation when its own build and the server's version differ, which means a stale cached page (reload, then hard reload).
