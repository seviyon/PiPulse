# PiPulse

A modern, from-scratch rewrite of [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) — real-time system monitoring for a Raspberry Pi (or any Linux single-board computer), with a lightweight collector daemon, an embedded time-series store, and a fast web dashboard.

> **Status: pre-alpha, Phase 3 complete.** One server process collects 11 metrics (CPU load, temperature, frequency, core voltage, throttling, memory, swap, `/` and `/boot` usage, network throughput) into SQLite and serves a live web dashboard, a REST API and a WebSocket feed — verified side by side with RPi-Monitor on a Raspberry Pi 2 (armv7l). Phase 4 (history & charts) is next — see [Roadmap](#roadmap).

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
- **Alerting** — a rules engine evaluates the same KPI values with configurable hysteresis (raise/cancel duration, resend interval) and triggers webhook/shell/log actions.

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
npm run build     # storage -> collector -> api -> web, in dependency order
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

Retention values are durations like `36h`, `14d`, `2w`, `1y`, or `forever`; an invalid value stops the server at startup. A minute-by-minute housekeeping job rolls raw samples up into 1-minute, hourly and daily averages and deletes data past its retention, but only once the next level already covers it. Changing a value takes effect within a minute of restarting: a longer retention keeps data longer from then on (already-deleted data doesn't come back); a shorter one prunes the excess. The defaults keep the database around 35 MB, sized for an SD card; with faster, larger storage (e.g. NVMe) you can keep much more raw detail.

Endpoints: `GET /api/config` (device, plugins, and the server's `serverTime` and `uptimeMs`), `GET /api/metrics/latest`, `GET /api/metrics/:id/history?from=&to=` (unix ms, default last hour), and `ws://…/api/live` (a `snapshot` of latest values on connect, then one `sample` message per new reading). There is no authentication yet — keep it on your LAN. If the host runs a firewall (e.g. ufw), open the port for your LAN only.

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

## Configuration

Configuration (collector plugins to enable, poll intervals, retention windows, alert rules, notification targets) lives in a single config file — details will be documented here once the config format is finalized in the collector/API packages.

## Roadmap

| Phase | Goal | Status |
| --- | --- | --- |
| 0 | Project scaffolding, lint/test setup, CI | ✅ Done |
| 1 | Collector core (plugin API + first metrics + SQLite writer) | ✅ Done |
| 2 | HTTP/WebSocket API | ✅ Done |
| 3 | Dashboard (status-page parity) | ✅ Done |
| 4 | History & charts (statistics-page parity) | ⏳ Next |
| 5 | Alerting engine & settings (authenticated, UI-editable retention) |  |
| 6 | Packaging (systemd + Docker, multi-arch CI) |  |
| 7 | Cutover from the legacy daemon |  |

## Credits

Inspired by [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) by Xavier Berger and contributors (GPLv3). PiPulse is an independent, clean-room rewrite — no original code is reused — released under its own license (see [LICENSE](LICENSE)).

## License

MIT — see [LICENSE](LICENSE). *(Confirm this is the license you want before publishing; since no GPLv3 code from the original is being reused, you're free to pick any license, but it's worth a deliberate choice rather than a default.)*
