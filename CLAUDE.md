# PiPulse — project instructions for Claude

PiPulse is a from-scratch TypeScript rewrite of [RPi-Monitor](https://github.com/RPi-Monitor/RPi-Monitor). This file is read automatically by Claude Code (CLI) when working in this repo, so it doesn't matter whether work continues here via Claude Code or via Cowork/claude.ai — both should end up looking at the same two documents below.

## Where the plan lives

- **`README.md`** — current status, tech stack with pinned versions, getting-started commands, and the roadmap table (which phase is done, which is next).
- **`docs/PLAN.md`** — the full modernization plan: legacy architecture review, every architecture decision and why, data/storage schema, API/frontend design, deployment plan, feature-parity matrix, the phase-by-phase build plan with exit criteria, testing strategy, security considerations, and future-proofing notes. Read this before starting a new phase.

Read both before proposing what to build next — `README.md`'s roadmap table is the quick status check, `docs/PLAN.md` has the reasoning and exit criteria behind each phase.

## Current status

Phase 0 (foundations) is done: npm-workspaces monorepo (`packages/storage`, `packages/collector`, `packages/api`, `packages/web`), lint (ESLint flat config), tests (Vitest, 10/10 passing), CI (GitHub Actions, Node 22.x/24.x matrix). `npm test`, `npm run build`, `npm run lint`, `npm run format`, and `npm audit` are all green as of the last commit.

Next up: **Phase 1 — Collector core** (see `docs/PLAN.md`'s step-by-step build plan for exact deliverables and exit criteria).

## Working conventions established so far

- Node.js >=22.13.0 required — storage uses the built-in `node:sqlite` (`DatabaseSync`), not `better-sqlite3` (dropped after npm/cli#9450 made it impossible to selectively allow its install script under this machine's `ignore-scripts=true`).
- Packages build in dependency order: storage → collector → api → web (no TS project references / `tsc -b` wired up — plain sequential `npm run build --workspace=...` calls in the root `package.json`).
- Keep core logic decoupled from specific libraries (Fastify, Preact, node:sqlite) behind small interfaces — see "Future-proofing & extensibility" in `docs/PLAN.md` for the reasoning (stable versioned `CollectorPlugin` interface, thin adapters, contract tests).
- Every phase's exit criterion includes tests passing in CI, not just Phase 0.
- Commit messages here have included a `Co-Authored-By`/`Claude-Session` trailer from whichever Claude surface made the change — keep doing that if your environment sets one.
