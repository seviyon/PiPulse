# PiPulse

[![CI](https://github.com/seviyon/PiPulse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seviyon/PiPulse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/seviyon/PiPulse)](https://github.com/seviyon/PiPulse/releases/latest)
[![License: MIT](https://img.shields.io/github/license/seviyon/PiPulse)](LICENSE)
[![CodeFactor](https://www.codefactor.io/repository/github/seviyon/pipulse/badge)](https://www.codefactor.io/repository/github/seviyon/pipulse)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)](docs/install.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-end%20to%20end-3178C6?logo=typescript&logoColor=white)](docs/architecture.md)
[![Raspberry Pi](https://img.shields.io/badge/Raspberry%20Pi-2%20and%20newer-C51A4A?logo=raspberrypi&logoColor=white)](docs/install.md)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen?logo=renovate)](renovate.json)
[![Last commit](https://img.shields.io/github/last-commit/seviyon/PiPulse)](https://github.com/seviyon/PiPulse/commits/main)
[![Open issues](https://img.shields.io/github/issues/seviyon/PiPulse)](https://github.com/seviyon/PiPulse/issues)
[![CodeRabbit reviews](https://img.shields.io/coderabbit/prs/github/seviyon/PiPulse)](https://coderabbit.ai)
[![Docker image](https://img.shields.io/badge/ghcr.io-seviyon%2Fpipulse-2496ED?logo=docker&logoColor=white)](https://github.com/seviyon/PiPulse/pkgs/container/pipulse)

A modern, from-scratch rewrite of [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) — real-time system monitoring for a Raspberry Pi (or any Linux single-board computer), with a lightweight collector daemon, an embedded time-series store, and a fast web dashboard.


> **Status: pre-alpha, but feature-complete up to Phase 6b.** One server process collects 12 metrics into SQLite, checks them against alert rules, sends webhook notifications, and serves a live dashboard, an Alerts page, a History page with zoomable charts from 1 hour to 1 year, a password-protected Settings page, a REST API and a WebSocket feed. Packaging (apt, tarball, Docker, automatic releases) is done, and from 0.7.0 a fresh install serves HTTPS from a certificate authority made for that Pi. Verified on a Raspberry Pi 2 (armv7l), including a year-equivalent database. See [Roadmap](#roadmap).

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

## Tech stack

| Layer | Choice | Version |
| --- | --- | --- |
| Runtime | Node.js | >=22.13.0 (needed for built-in `node:sqlite` without a flag) |
| Language | TypeScript, end to end | 5.9.3 |
| Metrics collection | [`systeminformation`](https://systeminformation.io/) + Pi-specific shell-outs | 5.33.13 |
| Storage | SQLite via built-in `node:sqlite` (`DatabaseSync`), WAL mode — no native module, no install step | Node built-in |
| API | [Fastify](https://fastify.io/) (HTTP + WebSocket) | 5.12.5 |
| Frontend | Preact + Vite (React-compatible, ~3 KB runtime) | Preact 10.29.8, Vite 8.3.0 |
| Testing | Vitest (unit/integration today), Playwright Test (end-to-end, Chromium only, in CI) | Vitest 5.0.1, Playwright 1.64.0 |
| Lint/format | ESLint (flat config) + Prettier | ESLint 10.11.0, Prettier 3.9.8 |
| Deployment | apt package and release tarball (systemd service, bundled Node), **and** a 64-bit Docker image (`linux/arm64`, `linux/amd64`) | — |

Dependency versions above reflect the last verified clean install (`npm install`, 0 vulnerabilities); see `package.json`/`package-lock.json` for exact ranges.

## Install

On a Raspberry Pi (or any Debian-based Linux), Pi 2 and newer, 32- or 64-bit:

```bash
curl -fsSL https://github.com/seviyon/PiPulse/releases/latest/download/install.sh | sudo sh
```

That adds PiPulse's signed apt repository and installs the `pipulse` package, which carries its own Node.js. It runs as the `pipulse` service on port **8889** (next to RPi-Monitor, which uses 8888). New releases arrive with `sudo apt upgrade`.

A fresh install serves **HTTPS** from a certificate authority made for this Pi: the installer prints its fingerprint, and you trust it once on each device ([HTTPS](docs/https.md)). An upgrade stays on plain HTTP until you run `sudo pipulse tls enable`. Settings live in `/etc/pipulse/pipulse.env`.

More: [reading the script first, the tarball, remove and Node support](docs/install.md), and [Docker](docs/docker.md).

## Documentation

| Page | What is in it |
| --- | --- |
| [Install](docs/install.md) | apt, tarball, the `pipulse` command, removing, Node.js support |
| [HTTPS](docs/https.md) | trusting the Pi's CA, your own certificate, renewal, backups and recovery |
| [Docker](docs/docker.md) | compose services, the CA sidecar, upgrading to 0.7.0 |
| [Configuration](docs/configuration.md) | every environment variable, retention, sign-in and Settings |
| [Alerts and notifications](docs/alerts.md) | built-in rules, your own rules file, webhooks |
| [API](docs/api.md) | REST endpoints and the live WebSocket |
| [Architecture](docs/architecture.md) | the packages and how they fit together |
| [Development](docs/development.md) | build, test, run from a checkout, end-to-end tests |
| [Plan](docs/PLAN.md) and [Releasing](docs/RELEASING.md) | the design decisions and how a release is made |

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
| 5b-3 | Notifications (webhook) | ✅ Done |
| 6 | Packaging (apt, tarball, Docker, releases, Renovate) | ✅ Done |
| 6b | HTTPS by default (a per-Pi CA, or your own certificate) | ✅ Done (6b-1 your own certificate, 6b-2a generated CA, 6b-2b status and alerts, 6b-2c default and Docker) |
| 7 | Cutover from the legacy daemon |  |

## Credits

Inspired by [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) by Xavier Berger and contributors (GPLv3). PiPulse is an independent, clean-room rewrite — no original code is reused — released under its own license (see [LICENSE](LICENSE)).

## License

MIT — see [LICENSE](LICENSE). *(Confirm this is the license you want before publishing; since no GPLv3 code from the original is being reused, you're free to pick any license, but it's worth a deliberate choice rather than a default.)*
