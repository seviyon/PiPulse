# PiPulse — project instructions for Claude

PiPulse is a from-scratch TypeScript rewrite of [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor). This file is read automatically by Claude Code (CLI) when working in this repo, so it doesn't matter whether work continues here via Claude Code or via Cowork/claude.ai — both should end up looking at the same two documents below.

## Where the plan lives

- **`README.md`** — current status, tech stack with pinned versions, getting-started commands, and the roadmap table (which phase is done, which is next).
- **`docs/PLAN.md`** — the full modernization plan: legacy architecture review, every architecture decision and why, data/storage schema, API/frontend design, deployment plan, feature-parity matrix, the phase-by-phase build plan with exit criteria, testing strategy, security considerations, and future-proofing notes. Read this before starting a new phase.

Read both before proposing what to build next — `README.md`'s roadmap table is the quick status check, `docs/PLAN.md` has the reasoning and exit criteria behind each phase.

## Current status

Phase 0 (foundations) is done: npm-workspaces monorepo (`packages/storage`, `packages/collector`, `packages/api`, `packages/web`), lint (ESLint flat config), tests (Vitest), CI (GitHub Actions, Node 22.x/24.x matrix).

Phase 1 (collector core) is done (PR #1): `packages/collector` has the versioned `CollectorPlugin` interface with runtime `validatePlugin()` checks and a contract suite run against every built-in plugin; six built-in plugins (`cpu_load`, `memory_used`, `network_rx`, `network_tx`, `disk_used`, `cpu_temperature`); `startScheduler()` (per-plugin intervals, skips a tick while the previous read is still in flight, `stop(timeoutMs)` drains before the db closes); and a `src/main.ts` daemon (`PIPULSE_DB_PATH`, clean SIGINT/SIGTERM shutdown). Exit criterion verified on the real Pi-hole Pi (armv7l): all six metrics landed at their configured 5 s / 10 s / 60 s intervals. 51 tests passing; `npm test`, `npm run build`, `npm run lint`, and `npm run format` all green.

Deferred from Phase 1: a `vcgencmd` plugin (Pi volts/throttling flags) — needs real `vcgencmd` output captured from the Pi to test against.

Phase 2 (API layer) is done (PR #4): `packages/api/src/server.ts` is a single process that runs the collector scheduler and serves Fastify REST (`/api/config`, `/api/metrics/latest`, `/api/metrics/:id/history` with schema-validated `from`/`to`) plus a `/api/live` WebSocket (`snapshot` on connect, then one `sample` per reading). The scheduler's `onSample` hook publishes into an in-process `LiveFeed` (a small interface in `packages/api`, so the API never imports the scheduler directly). Config via `PIPULSE_DB_PATH`, `PIPULSE_HOST`, `PIPULSE_PORT`. Exit criterion verified from a Mac against the Pi on port 8889: `curl` and a WebSocket client both returned live data. 65 tests passing.

Phase 3 (dashboard) is done (PRs #6, #7): `packages/web` is a Preact dashboard served by the API at `/` (`@fastify/static`, `PIPULSE_WEB_DIR`). Hostname header with model/OS/kernel/uptime from `/api/config`'s device section, a Live/Reconnecting indicator that pulses per sample, and one tile per plugin (formatted value, meter where there's a ceiling, 15-minute sparkline from history + live samples). Display-only status thresholds (icon + words, never colour alone) live in `packages/web/src/status.ts` until Phase 5's alert engine. Staleness and history windows use the Pi's clock (`serverTime`, then pushed sample timestamps). 11 built-in plugins now, including `swap_used`, `boot_used`, `cpu_frequency`, and `cpu_voltage`/`throttled` via `vcgencmd` (the previously deferred plugin). Exit criterion verified by screenshot side by side with RPi-Monitor's `status.html` on the Pi: PiPulse shows everything that page does except load averages and cumulative network totals, deferred to Phase 4. 176 tests passing.

Next up: **Phase 4 — History & charts** (see `docs/PLAN.md`'s step-by-step build plan for exact deliverables and exit criteria). Still planned, not built: Playwright end-to-end tests (the dashboard is covered by happy-dom render tests in Vitest).

## Working conventions established so far

- Node.js >=22.13.0 required — storage uses the built-in `node:sqlite` (`DatabaseSync`), not `better-sqlite3` (dropped after npm/cli#9450 made it impossible to selectively allow its install script under this machine's `ignore-scripts=true`).
- Packages build in dependency order: storage → collector → api → web (no TS project references / `tsc -b` wired up — plain sequential `npm run build --workspace=...` calls in the root `package.json`).
- Keep core logic decoupled from specific libraries (Fastify, Preact, node:sqlite) behind small interfaces — see "Future-proofing & extensibility" in `docs/PLAN.md` for the reasoning (stable versioned `CollectorPlugin` interface, thin adapters, contract tests).
- Every phase's exit criterion includes tests passing in CI, not just Phase 0.
- The target Pi (the Pi-hole box, hostname `Io`) is a **Raspberry Pi 2 Model B Rev 1.1**, **armv7l** (32-bit) and its system Node at `/usr/bin/node` is NodeSource 16.x — too old for `node:sqlite`. Phase 1 was verified with a newer per-user Node (nvm). Phase 6's systemd unit must either upgrade the system Node or point `ExecStart` at a Node >=22.13; stick to Node 22 LTS for armv7l builds.
- The Pi also runs **legacy RPi-Monitor on port 8888** until cutover (Phase 7), so run PiPulse on another port there (8889 was used for Phase 2). The Pi has **ufw active with default DROP**: any new port needs an allow rule (`sudo ufw allow from 192.168.1.0/24 to any port <port> proto tcp`), otherwise remote clients time out rather than get refused. Phase 6's install script should detect active ufw and warn if the port isn't allowed.
- `npm ci` on the Pi warns that esbuild's postinstall is blocked by `ignore-scripts` — harmless (esbuild is only a dev/build tool via tsx/Vite; the server never loads it). Don't approve it unless a build actually fails.
- The dev machine has `ignore-scripts=true`, which also makes npm skip `pre*`/`post*` lifecycle hooks. So `npm test` runs `npm run build` explicitly instead of via a `pretest` hook — don't reintroduce pre/post hooks for anything that must run.
- Vitest 5 ignores `vitest.workspace.ts`; the root `vitest.config.ts` uses `test.projects: ['packages/*']` so each package's own config applies.
- Commit messages here have included a `Co-Authored-By`/`Claude-Session` trailer from whichever Claude surface made the change — keep doing that if your environment sets one.
