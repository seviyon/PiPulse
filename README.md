# PiPulse

A modern, from-scratch rewrite of [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) — real-time system monitoring for a Raspberry Pi (or any Linux single-board computer), with a lightweight collector daemon, an embedded time-series store, and a fast web dashboard.

> **Status: planning / pre-alpha.** Architecture and roadmap are defined; implementation is starting. See [Roadmap](#roadmap) for current phase.

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

| Layer | Choice |
| --- | --- |
| Language | TypeScript (Node.js) end to end |
| Metrics collection | [`systeminformation`](https://systeminformation.io/) + Pi-specific shell-outs |
| Storage | SQLite (`better-sqlite3`), WAL mode |
| API | [Fastify](https://fastify.io/) (HTTP + WebSocket) |
| Frontend | Preact + Vite (React-compatible, ~3 KB runtime) |
| Testing | Vitest (unit/integration), Playwright (end-to-end) |
| Deployment | systemd unit **and** a multi-arch Docker image (`linux/arm64`, `linux/arm/v7`) |

## Getting started

> These commands describe the intended developer workflow and will start working as each package lands — check [Roadmap](#roadmap) for what's actually implemented today.

```bash
git clone https://github.com/<your-username>/PiPulse.git
cd PiPulse
npm install
npm run dev      # runs the collector, API, and web dashboard together in dev mode
```

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

| Phase | Goal |
| --- | --- |
| 0 | Project scaffolding, lint/test setup, CI |
| 1 | Collector core (plugin API + first metrics + SQLite writer) |
| 2 | HTTP/WebSocket API |
| 3 | Dashboard (status-page parity) |
| 4 | History & charts (statistics-page parity) |
| 5 | Alerting engine |
| 6 | Packaging (systemd + Docker, multi-arch CI) |
| 7 | Cutover from the legacy daemon |

## Credits

Inspired by [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) by Xavier Berger and contributors (GPLv3). PiPulse is an independent, clean-room rewrite — no original code is reused — released under its own license (see [LICENSE](LICENSE)).

## License

MIT — see [LICENSE](LICENSE). *(Confirm this is the license you want before publishing; since no GPLv3 code from the original is being reused, you're free to pick any license, but it's worth a deliberate choice rather than a default.)*
