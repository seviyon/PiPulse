# PiPulse

[![CI](https://github.com/seviyon/PiPulse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seviyon/PiPulse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/seviyon/PiPulse)](https://github.com/seviyon/PiPulse/releases/latest)
[![License: MIT](https://img.shields.io/github/license/seviyon/PiPulse)](LICENSE)
[![CodeFactor](https://www.codefactor.io/repository/github/seviyon/pipulse/badge)](https://www.codefactor.io/repository/github/seviyon/pipulse)
[![Coverage](https://codecov.io/gh/seviyon/PiPulse/graph/badge.svg)](https://codecov.io/gh/seviyon/PiPulse)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)](docs/install.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-end%20to%20end-3178C6?logo=typescript&logoColor=white)](docs/architecture.md)
[![Raspberry Pi](https://img.shields.io/badge/Raspberry%20Pi-2%20and%20newer-C51A4A?logo=raspberrypi&logoColor=white)](docs/install.md)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen?logo=renovate)](renovate.json)
[![Last commit](https://img.shields.io/github/last-commit/seviyon/PiPulse)](https://github.com/seviyon/PiPulse/commits/main)
[![Open issues](https://img.shields.io/github/issues/seviyon/PiPulse)](https://github.com/seviyon/PiPulse/issues)
[![CodeRabbit reviews](https://img.shields.io/coderabbit/prs/github/seviyon/PiPulse)](https://coderabbit.ai)
[![Docker image](https://img.shields.io/badge/ghcr.io-seviyon%2Fpipulse-2496ED?logo=docker&logoColor=white)](https://github.com/seviyon/PiPulse/pkgs/container/pipulse)

A modern, from-scratch rewrite of [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) — real-time system monitoring for a Raspberry Pi (or any Linux single-board computer), with a lightweight collector daemon, an embedded time-series store, and a fast web dashboard.


> **Status: in daily use, still before 1.0.** All [roadmap](#roadmap) phases are done, and PiPulse has replaced RPi-Monitor on the reference Pi, a Raspberry Pi 2 (armv7l).

## Why

The original RPi-Monitor is a great idea that hasn't had a real release since 2018: a single 1,566-line Perl script, presentation logic embedded as `eval`'d JS strings inside config files, RRDtool for storage, and a 2013-era jQuery/Flot/Bootstrap-3 frontend. PiPulse keeps the same core idea — collect KPIs, store them efficiently, show them live and historically — on a stack that's easier to test, extend, and run in 2026.

## Features

- Live dashboard over WebSocket: CPU load, frequency and voltage, throttling, temperature, memory, swap, disk and boot partition usage, network throughput
- History page with zoomable charts from 1 hour to 1 year, kept in an embedded database with configurable retention
- Alerts with hysteresis, edited in the browser or in a rules file, with acknowledging and webhook notifications (e.g. [Apprise](https://github.com/caronc/apprise))
- HTTPS by default on a fresh install, from a certificate authority made for that Pi, or your own certificate
- Sign-in: changing settings or rules needs an admin password (without one the dashboard is read-only), and reading can be protected too
- Updates page that says what `apt-get upgrade` would install (it installs nothing itself)
- REST API with JSON for current and historical metrics
- A native systemd service (apt or tarball) and an official Docker image

**Not built:**

- Shell-command and log alert actions (webhook only)
- A read-only mode for write-constrained storage
- A Prometheus `/metrics` endpoint or a Grafana data-source path
- Multi-device or fleet dashboards (PiPulse targets a single device)

**Deliberately not carried over from the original:**

- Config-file-authored, `eval`'d presentation logic, replaced by typed collector plugins and a real frontend
- The long tail of board-specific templates (Allwinner, OrangePi, sunxi, xbian, raspbmc, …); the plugin model leaves room to add boards later
- Bundled addons (Shellinabox, Hawkeye, etc.)

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js >=22.13.0 (needed for built-in `node:sqlite` without a flag); the packages and the Docker image bring their own: Node 22 on 32-bit ARM, Node 24 on 64-bit |
| Language | TypeScript, end to end |
| Metrics collection | [`systeminformation`](https://systeminformation.io/) + Pi-specific shell-outs |
| Storage | SQLite via built-in `node:sqlite` (`DatabaseSync`), WAL mode: no native module, no install step |
| API | [Fastify](https://fastify.io/) (HTTP + WebSocket) |
| Frontend | Preact + Vite (React-compatible, ~3 KB runtime), [uPlot](https://github.com/leeoniya/uPlot) for the charts |
| Testing | Vitest (unit and integration; happy-dom for the dashboard), Playwright Test (end-to-end, Chromium only, in CI), StrykerJS mutation testing (run by hand) |
| Lint/format | ESLint (flat config, typescript-eslint) + Prettier |
| Deployment | apt package and release tarball (systemd service, bundled Node), and a 64-bit Docker image (`linux/arm64`, `linux/amd64`, on Debian 12, scanned for known vulnerabilities monthly and after each release) |

Exact versions are in `package.json` and `package-lock.json`; Renovate keeps them current. TypeScript stays on 6.x until `typescript-eslint` supports TypeScript 7.

## Install

On a Raspberry Pi (or any Debian-based Linux), Pi 2 and newer, 32- or 64-bit:

```bash
curl -fsSL https://github.com/seviyon/PiPulse/releases/latest/download/install.sh | sudo sh
```

That adds PiPulse's signed apt repository and installs the `pipulse` package, which carries its own Node.js. It runs as the `pipulse` service on port **8889** (it can run next to RPi-Monitor, which uses 8888). New releases arrive with `sudo apt update && sudo apt upgrade`.

A fresh install serves **HTTPS** from a certificate authority made for this Pi: the installer prints its fingerprint, and you trust it once on each device ([HTTPS](docs/https.md)). An install upgraded from before 0.7.0 stays on plain HTTP until you run `sudo pipulse tls enable`. Settings live in `/etc/pipulse/pipulse.env`.

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
| 7 | Cutover from the legacy daemon | ✅ Done (RPi-Monitor stopped and disabled on the Pi 2026-10-18) |

## Credits

Inspired by [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor) by Xavier Berger and contributors (GPLv3). PiPulse is an independent, clean-room rewrite — no original code is reused — released under its own license (see [LICENSE](LICENSE)).

## License

MIT, see [LICENSE](LICENSE).
