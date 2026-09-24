# PiPulse

A modern, from-scratch rewrite of [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) — real-time system monitoring for a Raspberry Pi (or any Linux single-board computer), with a lightweight collector daemon, an embedded time-series store, and a fast web dashboard.

> **Status: pre-alpha; Phase 5b-2 (alert rules in the browser) is complete; 5b-3 (notifications) is next.** One server process collects 12 metrics (CPU load, load average, temperature, frequency, core voltage, throttling, memory, swap, `/` and `/boot` usage, network throughput) into SQLite, checks them against alert rules, and serves a live web dashboard with open alerts, an Alerts page, a History page with zoomable charts from 1 hour to 1 year, a password-protected Settings page for data retention, a REST API and a WebSocket feed — verified on a Raspberry Pi 2 (armv7l), including a year-equivalent database. See [Roadmap](#roadmap).

## Why

The original RPi-Monitor is a great idea that hasn't had a real release since 2018: a single 1,566-line Perl script, presentation logic embedded as `eval`'d JS strings inside config files, RRDtool for storage, and a 2013-era jQuery/Flot/Bootstrap-3 frontend. PiPulse keeps the same core idea — collect KPIs, store them efficiently, show them live and historically — on a stack that's easier to test, extend, and run in 2026.

## Features

**Planned for v1** (feature parity with the original, where it still makes sense):

- Live status dashboard (CPU load/frequency/voltage, memory, network throughput, disk/SD card usage, temperature)
- Historical charts with zoom, backed by a real embedded database instead of fixed-size RRD files
- Live updates over WebSocket instead of polling
- Configurable alerting with hysteresis (raise/cancel thresholds), notifying over webhook (e.g. [Apprise](https://github.com/caronc/apprise)), shell command, or log
- JSON export of current and historical metrics
- Read-only mode for write-constrained storage (SD cards, etc.)
- Both a native systemd service and an official Docker image

**Deliberately not carried over from the original:**

- Config-file-authored, `eval`'d presentation logic — replaced by typed collector plugins and a real frontend
- The long tail of board-specific templates (Allwinner, OrangePi, sunxi, xbian, raspbmc, …) — PiPulse targets a single device; the plugin model leaves room to add boards back later if needed
- Bundled addons (Shellinabox, Hawkeye, etc.) — a documented extension point may replace these later

**On the roadmap, not blocking v1:**

- A `/metrics` endpoint in Prometheus text format, and/or a Grafana data-source path, for anyone who wants to plug this into an existing observability stack
- Multi-device / fleet dashboards (out of scope for v1, which targets a single device)

## Architecture

```
PiPulse/
  packages/
    collector/   # metric plugins + scheduler
    storage/     # SQLite schema, migrations, query helpers
    alerts/      # alert rules, raise/clear decisions, 15 s engine
    api/         # Fastify HTTP + WebSocket server
    web/         # frontend dashboard (build)
  deploy/
    systemd/     # unit file, install script
    docker/      # Dockerfile, compose.yml
```

- **Collector** — small TypeScript plugins poll system metrics (via [`systeminformation`](https://systeminformation.io/) plus Pi-specific commands like `vcgencmd`) on their own interval and write samples to storage.
- **Storage** — SQLite (WAL mode). Raw samples are periodically downsampled into 1-minute/1-hour/1-day rollups and pruned, keeping the database size bounded the way RRD's fixed-size files did, but with configurable retention instead of a format baked in at file-creation time.
- **API** — a Fastify server exposes REST endpoints for current values, historical queries, and config, plus a WebSocket channel that pushes new samples as they arrive.
- **Web** — a browser dashboard consuming the API/WebSocket: a live status view, historical charts, and an alerts view.
- **Alerting** — a rules engine evaluates the same KPI values with hysteresis (a condition must last `for` a while to raise and be normal for `clearAfter` to clear) and shows open alerts on the dashboard; webhook/shell/log actions come later.

## Tech stack

| Layer | Choice | Version |
| --- | --- | --- |
| Runtime | Node.js | >=22.13.0 (needed for built-in `node:sqlite` without a flag) |
| Language | TypeScript, end to end | 5.9.3 |
| Metrics collection | [`systeminformation`](https://systeminformation.io/) + Pi-specific shell-outs | 5.33.13 |
| Storage | SQLite via built-in `node:sqlite` (`DatabaseSync`), WAL mode — no native module, no install step | Node built-in |
| API | [Fastify](https://fastify.io/) (HTTP + WebSocket) | 5.12.5 |
| Frontend | Preact + Vite (React-compatible, ~3 KB runtime) | Preact 10.29.8, Vite 8.3.0 |
| Testing | Vitest (unit/integration today), Playwright (end-to-end, planned) | Vitest 5.0.1 |
| Lint/format | ESLint (flat config) + Prettier | ESLint 10.11.0, Prettier 3.9.8 |
| Deployment | systemd unit **and** a multi-arch Docker image (`linux/arm64`, `linux/arm/v7`) | — |

Dependency versions above reflect the last verified clean install (`npm install`, 0 vulnerabilities); see `package.json`/`package-lock.json` for exact ranges.

## Getting started

Requires **Node.js >=22.13.0** (for built-in `node:sqlite` support with no experimental flag).

```bash
git clone https://github.com/<your-username>/PiPulse.git
cd PiPulse
npm install
npm run build     # storage -> collector -> alerts -> api -> web, in dependency order
npm test          # builds, then runs the Vitest suites across all packages
npm run dev       # runs the server (collector + API) in watch mode
```

To run the server (collector + dashboard + REST API + WebSocket feed) from a build, then open `http://<host>:8888/`:

```bash
PIPULSE_DB_PATH=~/pipulse-data/pipulse.sqlite PIPULSE_PORT=8888 \
  node --disable-warning=ExperimentalWarning packages/api/dist/server.js
```

| Variable          | Default          | Purpose                          |
| ----------------- | ---------------- | -------------------------------- |
| `PIPULSE_DB_PATH` | `pipulse.sqlite` | SQLite database file             |
| `PIPULSE_HOST`    | `0.0.0.0`        | Interface to bind                |
| `PIPULSE_PORT`    | `8888`           | HTTP/WebSocket port              |
| `PIPULSE_WEB_DIR` | `packages/web/dist` | Built dashboard to serve at `/` (API-only if missing) |
| `PIPULSE_ALLOWED_ORIGINS` | _(none)_ | Extra browser origins allowed on `/api/live`, comma-separated (e.g. behind a reverse proxy) |
| `PIPULSE_RETENTION_RAW` | `2d` | How long raw samples are kept |
| `PIPULSE_RETENTION_1M` | `14d` | How long 1-minute averages are kept |
| `PIPULSE_RETENTION_1H` | `1y` | How long hourly averages are kept |
| `PIPULSE_RETENTION_1D` | `forever` | How long daily averages are kept |
| `PIPULSE_ALERTS_FILE` | _(none)_ | JSON file of alert rules merged over the built-ins (see [Alerts](#alerts)) |
| `PIPULSE_ADMIN_PASSWORD_HASH_FILE` | _(none)_ | File with the admin password hash (make one with `hash-password`); unset = read-only (see [Sign-in and settings](#sign-in-and-settings)) |
| `PIPULSE_PROTECT_READS` | `false` | `true`: every page, API read and the live feed need sign-in |

Retention values are durations like `36h`, `14d`, `2w`, `1y`, or `forever`; an invalid value stops the server at startup. A minute-by-minute housekeeping job rolls raw samples up into 1-minute, hourly and daily averages (daily on the server's local calendar days) and deletes data past its retention, but only once the next level already covers it. Retention can also be changed on the Settings page, without a restart; a variable that is set wins and locks that field there. Levels must stay in order (raw ≤ 1-minute ≤ hourly ≤ daily); variables out of order stop the server at startup. A longer retention keeps data longer from then on (already-deleted data doesn't come back); a shorter one prunes the excess within a minute. After a large deletion the database compacts itself (at most once a day, only when at least a quarter of an 8 MB+ file is free and the disk has room for about twice the file). The defaults keep the database around 35 MB, sized for an SD card; with faster, larger storage (e.g. NVMe) you can keep much more raw detail.

Endpoints: `GET /api/config` (device, including its CPU count, plugins, the alert `rules` in force, and the server's `serverTime` and `uptimeMs`), `GET /api/metrics/latest`, `GET /api/metrics/:id/history?from=&to=` (raw samples, unix ms, default last hour), `GET /api/metrics/:id/series?from=&to=&resolution=` (avg/min/max points plus `count`, the raw samples each point stands for, default last 24 hours; `resolution` is `auto` (default), `raw`, `1m`, `1h` or `1d`, and `auto` picks the finest one that retention hasn't thinned in the range and that has at most ~1500 points there, so a new install's long ranges show the readings collected so far), `GET /api/alerts?state=&from=&to=&limit=` (`state` is `all` (default: open alerts plus any active during the window), `active`, or `cleared` (cleared during the window, newest cleared first); the window defaults to the last 30 days, newest raised first, up to `limit` (default 100, max 1000)), and `ws://…/api/live` (a `snapshot` of latest values and open `alerts` on connect, then one `sample` message per new reading and one `alert` message whenever an alert opens or clears), `GET /api/session` (`editable`, `signedIn`, `protectReads`), `POST /api/login` / `POST /api/logout`, and `GET /api/settings`, `POST /api/settings/preview`, `PUT /api/settings` (retention per level with its source, storage figures, what a change would delete, and saving it — a change that deletes data needs `confirmDeletion: true`). Every write needs a signed-in session; reads need one only with `PIPULSE_PROTECT_READS=true`. PiPulse speaks plain HTTP, so keep it on your LAN. If the host runs a firewall (e.g. ufw), open the port for your LAN only.

On a Raspberry Pi, core voltage and throttling come from `vcgencmd`, which only works if the user running PiPulse is in the `video` group (`sudo usermod -aG video <user>`, then restart PiPulse), or, in Docker, if the container gets `--device /dev/vchiq`. Otherwise those two tiles stay on "No readings yet" and the log says why, once for each.

To run only the collector daemon, without the API (writes to `PIPULSE_DB_PATH`, default `./pipulse.sqlite`; stop with Ctrl-C):

```bash
PIPULSE_DB_PATH=~/pipulse-data/pipulse.sqlite npm run start --workspace=packages/collector
```

> For dashboard development, run the server (`npm run dev`) and, in a second terminal, `npm run dev --workspace=packages/web`. Vite serves the dashboard on port 5173 and proxies `/api` and the WebSocket to the server (`PIPULSE_API`, default `http://localhost:8888`).

### Running in production

**Native (systemd)**

```bash
npm run build
sudo ./deploy/systemd/install.sh
sudo systemctl enable --now pipulse
```

**Docker**

```bash
docker compose -f deploy/docker/compose.yml up -d
```

The Docker image needs host visibility to report accurate host metrics — the compose file mounts `/proc` and `/sys` (read-only) and runs with `pid: host`. Keep the container on your LAN only; don't publish its port to the internet.

## Alerts

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

Signed in, rules can be added, edited, disabled and reverted, and open alerts acknowledged, on the Alerts page; saved rules sit above `PIPULSE_ALERTS_FILE` and the built-ins and apply within 15 seconds, no restart needed. Notifications (e.g. a webhook to Apprise) are still to come.

## Sign-in and settings

Without a password PiPulse is read-only: everything shows, nothing can be changed. To enable editing:

```bash
node packages/api/dist/hash-password.js > ~/pipulse-admin.hash   # asks twice, prints one line
chmod 600 ~/pipulse-admin.hash
PIPULSE_ADMIN_PASSWORD_HASH_FILE=~/pipulse-admin.hash node packages/api/dist/server.js
```

Only the scrypt hash is stored; to change the password, make a new file and restart. Sign in on the Settings page; the session lasts 7 days from last use, and a restart signs you out. Five wrong passwords from one address lock it out for 15 minutes.

The Settings page shows each retention level, where its value comes from (default, saved, or locked by a `PIPULSE_RETENTION_*` variable), how much is stored, and the database and disk size. **Review changes** shows what a shorter retention will delete and an estimated database size; deleting anything needs an explicit tick before **Save**. Changes apply within a minute, no restart.

Set `PIPULSE_PROTECT_READS=true` to require sign-in for everything, including the live feed.

PiPulse speaks plain HTTP: the password crosses the network once at sign-in. Keep it on your LAN; putting it behind a TLS reverse proxy is planned (see `docs/PLAN.md`, "Future: behind a reverse proxy").

## Configuration

Configuration is environment variables for now (see the table under [Getting started](#getting-started)), plus the alert rules file described under [Alerts](#alerts). Retention is editable on the Settings page (see [Sign-in and settings](#sign-in-and-settings)); alert rules are editable on the Alerts page (see [Alerts](#alerts)), signed in. Plugin selection and poll intervals are fixed in code.

## Roadmap

| Phase | Goal | Status |
| --- | --- | --- |
| 0 | Project scaffolding, lint/test setup, CI | ✅ Done |
| 1 | Collector core (plugin API + first metrics + SQLite writer) | ✅ Done |
| 2 | HTTP/WebSocket API | ✅ Done |
| 3 | Dashboard (status-page parity) | ✅ Done |
| 4 | History & charts (statistics-page parity) | ✅ Done |
| 5a | Alerting (rules, dashboard alerts) | ✅ Done |
| 5b-1 | Sign-in, settings, retention editor | ✅ Done |
| 5b-2 | Alert rules in the browser, acknowledging alerts | ✅ Done |
| 5b-3 | Notifications (webhook) | ⏳ Next |
| 6 | Packaging (systemd + Docker, multi-arch CI) |  |
| 7 | Cutover from the legacy daemon |  |

## Credits

Inspired by [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) by Xavier Berger and contributors (GPLv3). PiPulse is an independent, clean-room rewrite — no original code is reused — released under its own license (see [LICENSE](LICENSE)).

## License

MIT — see [LICENSE](LICENSE). *(Confirm this is the license you want before publishing; since no GPLv3 code from the original is being reused, you're free to pick any license, but it's worth a deliberate choice rather than a default.)*
