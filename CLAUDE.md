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

Next up: **Phase 2 — API layer** (see `docs/PLAN.md`'s step-by-step build plan for exact deliverables and exit criteria).

## Working conventions established so far

- Node.js >=22.13.0 required — storage uses the built-in `node:sqlite` (`DatabaseSync`), not `better-sqlite3` (dropped after npm/cli#9450 made it impossible to selectively allow its install script under this machine's `ignore-scripts=true`).
- Packages build in dependency order: storage → collector → api → web (no TS project references / `tsc -b` wired up — plain sequential `npm run build --workspace=...` calls in the root `package.json`).
- Keep core logic decoupled from specific libraries (Fastify, Preact, node:sqlite) behind small interfaces — see "Future-proofing & extensibility" in `docs/PLAN.md` for the reasoning (stable versioned `CollectorPlugin` interface, thin adapters, contract tests).
- Every phase's exit criterion includes tests passing in CI, not just Phase 0.
- The target Pi (the Pi-hole box) is **armv7l** (32-bit) and its system Node at `/usr/bin/node` is NodeSource 16.x — too old for `node:sqlite`. Phase 1 was verified with a newer per-user Node (nvm). Phase 6's systemd unit must either upgrade the system Node or point `ExecStart` at a Node >=22.13; stick to Node 22 LTS for armv7l builds.
- Commit messages here have included a `Co-Authored-By`/`Claude-Session` trailer from whichever Claude surface made the change — keep doing that if your environment sets one.
