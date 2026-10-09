# End-to-end Tests (Playwright) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. If your tool has no such skills, the steps stand alone.

**Goal:** A small, non-flaky Playwright suite that drives the real dashboard in Chromium against a real `packages/api` server process, run on every PR in CI, so the joints that the happy-dom render tests can't reach (WebSocket push, reconnects, cookies, the sign-in gate and its `4401` close, live alerts across tabs, HTTPS and the plain-HTTP hint page) are checked before merge.

**Architecture:** A new **standalone** folder `e2e/` at the repo root (not a workspace, not under `packages/`), with its own `package.json` and `package-lock.json` holding only `@playwright/test`. A harness (`e2e/src/harness/`, compiled by `tsc` to `e2e/dist/`) starts the **unchanged** built server `packages/api/dist/server.js` once per test, with a throwaway database and a scrubbed environment. Readings come from fake plugins that a Node module hook (`node --import e2e/dist/harness/register.js`) substitutes for `@pipulse/collector`'s `builtinPlugins` in that one process: the fakes keep every id, label and unit, poll every second and read their values from a JSON control file the test writes. The same hook shortens the alert engine's check interval. **No production code changes.** Specs live in `e2e/specs/*.e2e.ts`; harness unit tests in `e2e/test/*.test.ts` (Vitest).

**Tech Stack:** TypeScript (strict), Node ≥ 22.15 for the harness (`module.registerHooks`), `@playwright/test` (exact pin), Vitest 5 (harness tests only), Chromium from Playwright's own build (the operator's decision: no Firefox or WebKit).

**Spec:** none separate; this plan is the design. It implements the "End-to-end" row of `docs/PLAN.md` → "Testing strategy". Where this plan departs from that row, see [Spec corrections needed](#spec-corrections-needed).

**The Pi:** `Io` is mid-way through a one-week unattended soak. **Nothing in this plan runs on, deploys to, upgrades or otherwise touches `Io`.** No task needs a Pi; the exit criterion runs in CI and on the Mac.

## Open questions (operator decides)

1. **Which browsers, and which checks are required on `main`?** _Decided by the operator:_ **Chromium only**; Firefox and WebKit are not run at all. The CI job is a single `e2e` job (no matrix), and `e2e` becomes the one required check once PR 1 has run green on `main`. Consequence, accepted: nothing here checks rendering or behaviour in Safari or Firefox, which the operator uses; the happy-dom render tests and manual use remain the only cover there. Adding a browser later is a config change (a project in `playwright.config.ts` plus a matrix in the job).
2. **Should Renovate bumps of `@playwright/test` keep automerging?** _Decided by the operator:_ **yes**, unchanged. They are devDependency patch/minor updates, so today's rules automerge them once CI is green, and the required `e2e` job (with a fresh Chromium build) is that gate. A bump that breaks Chromium stays open as a red PR. No `renovate.json` change.

Everything else is decided below.

## Decisions

**D1 — Coverage, ranked by risk × value.** E2E checks only what crosses the browser/server boundary; anything a unit test already pins down stays out.

| #   | Journey                                                                                                                                                                                  | Why e2e                                                                            | Already covered by units (not repeated)                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Now page: tiles render, values change live over `/api/live`, Live indicator; server stops → "Reconnecting", restarts → "Live"                                                            | The whole pipeline (scheduler → feed → WebSocket → store → tile) in a real browser | `packages/web/test/tile.test.tsx`, `live.test.ts`, `store.test.ts`; `packages/api/test/live.test.ts`, `server.test.ts`                   |
| 2   | Sign-in/out, read-only without a password, `PIPULSE_PROTECT_READS` gate, WebSocket close `4401`, then Live after sign-in                                                                 | Security; real cookie handling (`HttpOnly`, `SameSite=Strict`) differs per browser | `auth-routes.test.ts` (hook, percent-encoding, limits), `auth.test.ts`, `sign-in.test.tsx`, `app.test.tsx`                               |
| 3   | Alerts: a breach raises live (tile line, nav badge, Open list); Acknowledge in one tab drops the badge in another; clear → Recent; a rule created in the editor raises without a reload  | Engine → feed → two browser tabs; the only place all of it runs together           | `packages/alerts/test/*`, `alert-routes.test.ts`, `alerts-page.test.tsx`, `rules-editor.test.tsx`, `rule-form.test.ts`                   |
| 4   | Settings retention: Review changes → preview → Save disabled until "I understand this deletes data" → saved → survives reload                                                            | The confirm flow and `409` round trip through a real browser                       | `settings-routes.test.ts`, `settings-page.test.tsx`, `settings.test.ts`, storage `retention*.test.ts`, `usage.test.ts`, `vacuum.test.ts` |
| 5   | History: ranges load from a seeded database; drag-to-zoom refetches a narrower window; Reset zoom                                                                                        | uPlot drag needs real pointer events and layout; happy-dom has neither             | `history.test.ts`, `history-page.test.tsx`, `series.test.ts`, storage `rollup.test.ts`                                                   |
| 6   | HTTPS (small separate project): dashboard Live over `wss://`, session cookie `Secure`, `http://` to the HTTPS port shows the hint page, Certificate section shows the served certificate | Real TLS + browser behaviour; the hint page through a browser, not only raw bytes  | `https.test.ts`, `plain-http-hint.test.ts`, `tls-status.test.ts`, `certificate.test.tsx`, `certificate-coverage.test.tsx`                |

**Not covered, on purpose:** webhook delivery (`packages/notify` tests and `notify-test` cover it; a receiver adds a moving part for no browser value); the retention _deletion_ itself and `VACUUM` timing (housekeeping runs once a minute; storage tests cover it); the sign-in rate limit (unit-tested; five wrong passwords per test would also slow the suite); generated CA, renewal, `pipulse tls` and Docker (packaging tests); pixel or screenshot comparisons (fonts differ by OS; uPlot draws to a canvas); staleness notes, DST, About and Notifications sections (unit-tested renders); mobile layout.

**D2 — Server under test: the real built server, unchanged, one per test.** Each test gets a fresh temp folder, database and `node packages/api/dist/server.js` process on `PIPULSE_PORT=0` (ephemeral), `PIPULSE_HOST=127.0.0.1`, the URL parsed from the `listening on` log line exactly as `packages/api/test/server.test.ts` does. A test-scoped server costs one process start per test but makes ordering irrelevant and lets each test pick its own configuration (password, read protection, alerts file, TLS, seeded history). Playwright's `webServer` option is rejected: one shared server for the run can't vary configuration and leaks state between tests.

**D3 — Controllable readings without touching production code: a module hook.** `server.ts` takes its plugins from `builtinPlugins` and its engine from `startAlerts` with no injection point. Options considered:

- _A new env var that loads a plugin module_ — rejected: it makes "code from configuration" possible in production, against the project's "rules are data, never code" stance.
- _Refactor `server.ts` into an injectable `startPipulse()`_ — rejected for now: a large change to the one process wiring auth, TLS and the engine, for test convenience only.
- _Write readings into SQLite from the test_ — rejected: the WebSocket only pushes the scheduler's samples, and real plugins keep writing real values beside them (on CI, `disk_used` can already sit above 70 % and raise `disk_filling`).
- **Chosen:** `node --import <e2e>/dist/harness/register.js …/server.js`. `register.js` calls `module.registerHooks` with a `resolve` hook that redirects exactly two bare specifiers, and only when the importing module is the real `packages/api/dist/server.js` (compared by real path): `@pipulse/collector` → `fake-collector.js` and `@pipulse/alerts` → `fake-alerts.js`. `fake-collector.js` does `export * from` the real collector and shadows `builtinPlugins` with fakes (a module's own export wins over a star export). `fake-alerts.js` re-exports the real package and shadows `startAlerts` with a wrapper that passes `intervalMs` from `PIPULSE_E2E_ALERT_INTERVAL_MS` (default 1000). Nothing in `packages/` reads any `PIPULSE_E2E_*` variable.

  Production risk: none at runtime (the hook exists only in processes the harness spawns, and `e2e/` is never packaged: see D5). The real risk is silent drift: if `server.ts` stops importing those specifiers, the hook would no longer apply and the tests would see real readings. So the harness refuses to hand out a server unless `/api/config` reports every plugin at the fake interval (1000 ms; no built-in polls that fast) — a drift fails every test loudly with "fake collector not loaded".

  Fakes: same `id`, `label`, `unit`, `apiVersion` as each built-in, `intervalMs` 1000, `collect()` reads `<dir>/readings.json` (`{ "<id>": number | null }`; missing or `null` → `null`, "no reading"). Defaults keep every built-in rule quiet: `cpu_load` 12, `load_1` 0.2, `cpu_temperature` 45, `cpu_frequency` 1200, `cpu_voltage` 1.2, `throttled` 0, `memory_used` 35, `swap_used` 10, `swap_io` 0, `disk_used` 40, `boot_used` 30, `network_rx` 1000, `network_tx` 500. The test changes values with `server.setReadings({...})` (write to a temp file, then `rename`, so a poll never reads half a file).

  Time: no fake clocks in the server. Alerts use short durations from a test rules file (`for`/`clearAfter` `2s`) with the 1 s engine interval, so a raise or clear lands within a few seconds. The browser clock is never faked either: staleness and uptime are unit-tested, and `page.clock` would interfere with the retry timers the reconnect test relies on.

**D4 — Environment and isolation.** The server's environment is built from scratch, never `...process.env`: `PATH`, `HOME`, `TZ=UTC`, `LANG=C.UTF-8`, and only the `PIPULSE_*` the test asked for, so a developer's own `PIPULSE_*` settings never leak in. Always set: `PIPULSE_DB_PATH=<dir>/pipulse.sqlite`, `PIPULSE_HOST`, `PIPULSE_PORT`, `PIPULSE_WEB_DIR=<repo>/packages/web/dist` (the harness fails fast if `index.html` is missing, instead of the server silently going API-only), `PIPULSE_RUNTIME_DIR=<dir>/run` (absent, so nothing is written to a real `/run/pipulse`), `PIPULSE_TLS=off` unless the test asks for HTTPS. Browser contexts use `timezoneId: 'UTC'`. Server stdout/stderr are kept and attached to the test report on failure. Teardown sends `SIGTERM`, waits for exit (`SIGKILL` after 5 s) and deletes the folder.

Password: the harness writes `<dir>/admin.hash` with `hashPassword('e2e-password', { N: 1024, r: 8, p: 1 })` imported from the built `packages/api/dist/auth.js` (the cost `packages/api/test/auth-routes.test.ts` uses), mode `0600`. Seeded history: `openDb` + `insertSample` from `@pipulse/storage` before the server starts (resolved through the root `node_modules` workspace links; `e2e/` declares no `@pipulse/*` dependency).

HTTPS: `PIPULSE_TLS=on`, `PIPULSE_TLS_CERT=<dir>/cert.pem` (`leaf.crt` + `intermediate.crt` from `packages/tls/test/fixtures`, SANs `localhost`, `pipulse.test`, `127.0.0.1`, valid to 2125), `PIPULSE_TLS_KEY=<dir>/key.pem` (`leaf.key`, `0600`), `PIPULSE_TLS_TIMESYNC_DIR=<dir>/timesync` with a `synchronized` file — the same set-up as `server.test.ts`'s HTTPS cases. A Playwright browser can't easily be told to trust a private root, so the HTTPS project alone sets `ignoreHTTPSErrors: true`; to keep the certificate itself verified, the HTTPS fixture first makes one Node `https` request with `ca: root-ca.crt` and `servername: 'localhost'` and fails if it doesn't verify. Production TLS and auth are untouched.

**D5 — Where the files live: a standalone `e2e/` folder.** Not `packages/e2e`: `packaging/build-tarball.sh` and the `Dockerfile` copy every `packages/*/` (and `die` if one has no `dist/`), so an e2e package there would either break the release or ship the fake-collector hook. Not a root workspace either: the tarball copies the root `package-lock.json` and runs `npm ci --omit=dev` without the e2e folder. Not `tests/` or `test/`: Renovate's `config:recommended` ignores `**/test/**` and `**/tests/**`, so `@playwright/test` would never be updated. A standalone folder also keeps Playwright and its browsers out of the root `npm ci`, out of root `npm test`, and out of Vitest's `projects: ['packages/*']`. `.dockerignore` gains `e2e` so the image build context stays the same.

**D6 — Runner and browsers.** Playwright Test, not Vitest + `playwright` library: it gives per-test browser contexts, fixtures with scopes, web-first assertions with auto-wait, traces, and per-project browsers for free. Browser: **Chromium only** (Q1), on every PR. There are two Playwright projects: `chromium` (`testIgnore: /https\//`) and `chromium-https` (`testMatch: /https\//`, `ignoreHTTPSErrors: true`). No browser-selection environment variable exists.

Version: `@playwright/test` pinned **exactly** (`"<pin at implementation: check npm for the current stable>"`, no `^`), unlike the rest of the repo's caret ranges, because each Playwright release is tied to specific browser builds and the CI cache key. Renovate rewrites the exact pin on bumps (rangeStrategy `auto` keeps pins pinned).

Browser binaries are installed only by an explicit command — `npx --prefix e2e playwright install chromium` (add `--with-deps` on Linux) — never from an npm lifecycle script (the dev machine runs `ignore-scripts=true`, and `CLAUDE.md` bans pre/post hooks). If the pinned `@playwright/test` or its dependencies carry install scripts (check `npm view <pkg>@<version> scripts` at implementation), list them in `e2e/package.json`'s `allowScripts` as `false`, as the root does for `esbuild` and `fsevents`.

**D7 — Flake rules.** `retries: 0` locally and in CI (a retry hides the flake that a trace would explain); `trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`, `video: 'off'`. `workers: 2` in CI (`process.env.CI`), Playwright's default locally; `fullyParallel: true` is safe because every test has its own server. In specs: no `waitForTimeout` or `setTimeout` (`playwright/no-wait-for-timeout` is not installed, so reviewers check it; a grep in Task 14's checklist enforces it); locate by role and accessible name; assert with web-first `expect(locator).toHaveText/toContainText/toBeVisible`; wait for WebSocket data by asserting the DOM the data produces (a tile showing a value the control file just set), never by counting frames; where a request matters (zoom), wait with `page.waitForRequest` set up before the action. Assertions that wait on the alert engine use an explicit `{ timeout: 15_000 }`; everything else keeps Playwright's 5 s default. Test timeout 30 s.

**D8 — Selectors.** The dashboard is already well labelled: tiles are `section`s with `aria-labelledby` (role `region`, name = plugin label, `packages/web/src/tile.tsx`); the connection line is `role="status"` (`app.tsx`); nav is `nav[aria-label="Pages"]` with link names (the Alerts link's `aria-label` carries the open count and severity); Alerts/Settings/Certificate sections have headings with ids; charts are `role="img"` named by title (`chart.tsx`); retention and rule fields have `<label for>`; the sign-in field is labelled "Password". **No `data-testid` is planned.** Tile values are read with `toContainText` on the tile region. A drag-to-zoom uses the bounding box of the chart's `role="img"`. If a builder finds an element with no accessible handle, prefer adding a real label or role in `packages/web` (better for screen readers too) in the same task, with a render test; add a `data-testid` only if a label would be wrong for users, and say why in the commit.

## Delivery: three PRs

| PR    | Tasks | Ships                                                                                         | Label |
| ----- | ----- | --------------------------------------------------------------------------------------------- | ----- |
| **1** | 1–6   | `e2e/` scaffold, fake plugins + hook, launcher, fixtures, the Now-page smoke spec, the CI job | none  |
| **2** | 7–12  | Reconnect, auth, alerts, settings, history and HTTPS specs                                    | none  |
| **3** | 13–14 | Docs and the manual exit criterion                                                            | none  |

No PR changes what ships, so none takes a `release:*` label. Each PR leaves `main` green: PR 1's CI job runs only the smoke spec, and the job is not required until the operator adds it (Task 6).

## Global Constraints

- **No changes under `packages/` or `packaging/`**, except a label/role fix in `packages/web` per D8 (with its own render test). Never add an env var, route or branch to production code for tests; never weaken auth, origin checks or TLS.
- `Io` is not touched by any task, test or checklist step.
- Harness Node: `module.registerHooks` needs Node ≥ 22.15 (present in 22.x and 24.x on CI). `register.ts` throws `"e2e harness needs Node >= 22.15 (module.registerHooks)"` when it is missing. `e2e/package.json` `engines.node` is `>=22.15.0`. The server itself still runs on ≥ 22.13.
- No npm `pre*`/`post*` scripts anywhere, and no browser download in any install script.
- `e2e/` is not a workspace and never appears in the root `workspaces`, root `build`, root `test`, or Vitest's root `projects`.
- No `PIPULSE_E2E_*` name may appear under `packages/` (Task 14 greps for it).
- Specs: no fixed sleeps; role/label locators; web-first assertions (D7, D8).
- **A clean checkout has no `dist/`** (`.gitignore` excludes it): `packages/api/dist/server.js`, `packages/web/dist` and the other packages' `dist/` exist only after the root `npm run build`. Every step that runs the harness tests (`paths.test.ts` needs `SERVER_JS` to be a real path; `fakes.test.ts` imports the real `builtinPlugins`; `register.test.ts` and `launch.test.ts` spawn the built server) therefore runs the root `npm run build` first. The CI job and the root `test:e2e` script already do.
- Every task ends with `npm run lint`, `npm run format` and, from Task 2 on, `npm --prefix e2e test` (or the subset the task says) passing.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The hook can only redirect inside a harness-spawned process.** `register.ts` must compare the importer against the real path of `packages/api/dist/server.js` and redirect only `@pipulse/collector` and `@pipulse/alerts`; the fakes import the real packages through normal resolution (no loop). Test in Task 3.
2. **Drift fails loudly.** With the hook not applied (start the server without `--import`), the launcher must throw "fake collector not loaded" instead of running tests on real readings. Test in Task 4.
3. **No environment leaks.** With `PIPULSE_PROTECT_READS=true` and `PIPULSE_TLS=on` in the developer's own environment, a default harness server still starts on HTTP without read protection. Test in Task 4.
4. **`ignoreHTTPSErrors` stays confined** to the `*-https` projects, and the HTTPS fixture's verified Node request (with `root-ca.crt`) fails the test when the served chain is wrong. Test in Task 12.
5. **The `4401` assertion is real:** read from a `WebSocket`'s `close` event inside the page, not inferred from the sign-in form being shown. Test in Task 8.

---

## File Structure

| File                                             | Change | Responsibility                                                                          |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------- |
| `e2e/package.json`, `e2e/package-lock.json`      | create | `@playwright/test` (exact), scripts `build`, `test`, `test:harness`, `test:browsers`    |
| `e2e/tsconfig.json`                              | create | Harness build (`src` → `dist`), extends `../tsconfig.base.json`                         |
| `e2e/tsconfig.specs.json`                        | create | `--noEmit` typecheck of `specs/`, `test/` and `playwright.config.ts`                    |
| `e2e/vitest.config.ts`                           | create | Harness unit tests only (`test/**/*.test.ts`)                                           |
| `e2e/playwright.config.ts`                       | create | Projects per browser (+ `-https`), D7 settings                                          |
| `e2e/src/harness/paths.ts`                       | create | Repo paths (server, web dist, fixtures), all real paths                                 |
| `e2e/src/harness/readings.ts`                    | create | Default fake values, `writeReadings` (atomic), `readReadings`                           |
| `e2e/src/harness/fake-collector.ts`              | create | Re-exports the real collector; shadows `builtinPlugins` with fakes                      |
| `e2e/src/harness/fake-alerts.ts`                 | create | Re-exports the real alerts package; shadows `startAlerts` (interval)                    |
| `e2e/src/harness/register.ts`                    | create | `module.registerHooks` resolve hook (D3)                                                |
| `e2e/src/harness/launch.ts`                      | create | `startServer(options)` → `{ baseUrl, port, dir, setReadings, stop, restart, logs }`     |
| `e2e/test/*.test.ts`                             | create | Vitest tests of the harness                                                             |
| `e2e/specs/fixtures.ts`                          | create | Playwright `test` with `serverOptions` and `server` fixtures, `signIn` helper           |
| `e2e/specs/*.e2e.ts`, `e2e/specs/https/*.e2e.ts` | create | The journeys                                                                            |
| `package.json` (root)                            | modify | Script `test:e2e` only                                                                  |
| `.gitignore`, `.prettierignore`, `.dockerignore` | modify | `e2e/test-results/`, `e2e/playwright-report/`, `e2e/dist/`; `.dockerignore`: `e2e`      |
| `eslint.config.js`                               | modify | Ignore `e2e/test-results/**`, `e2e/playwright-report/**` (`**/dist/**` already ignored) |
| `.github/workflows/ci.yml`                       | modify | Job `e2e`                                                                               |
| `README.md`, `docs/PLAN.md`, `CLAUDE.md`         | modify | Testing docs, conventions, status                                                       |

---

### Task 1: Scaffold `e2e/`

**Model:** Haiku or Sonnet. **PR 1.**

**Files:** create `e2e/package.json`, `e2e/tsconfig.json`, `e2e/tsconfig.specs.json`, `e2e/vitest.config.ts`, `e2e/src/harness/paths.ts`, `e2e/test/paths.test.ts`; modify root `package.json`, `.gitignore`, `.prettierignore`, `.dockerignore`, `eslint.config.js`.

- [ ] **Step 1: Failing test** `e2e/test/paths.test.ts`: `SERVER_JS` ends with `packages/api/dist/server.js` and is a real path (`realpathSync(SERVER_JS) === SERVER_JS`); `WEB_DIST` ends with `packages/web/dist`; `TLS_FIXTURES` contains `leaf.crt`, `leaf.key`, `intermediate.crt`, `root-ca.crt`; `REPO_ROOT` contains `CLAUDE.md`.
- [ ] **Step 2: Scaffold.**
  - `e2e/package.json`: `"name": "pipulse-e2e"`, `"private": true`, `"type": "module"`, `"engines": { "node": ">=22.15.0" }`, `devDependencies: { "@playwright/test": "<pin at implementation: check npm for the current stable>" }` (exact), `allowScripts` per D6, scripts:
    - `"build": "tsc -p tsconfig.json && tsc -p tsconfig.specs.json"`
    - `"test:harness": "NODE_OPTIONS=--disable-warning=ExperimentalWarning vitest run"`
    - `"test:browsers": "NODE_OPTIONS=--disable-warning=ExperimentalWarning playwright test"`
    - `"test": "npm run build && npm run test:harness && npm run test:browsers"`
      `tsc` and `vitest` come from the root `node_modules/.bin` (npm puts every ancestor's `.bin` on `PATH`; confirm with `npm --prefix e2e exec -- which tsc`). Run `npm install --prefix e2e` once to create `e2e/package-lock.json`; commit it.
  - `e2e/tsconfig.json`: extends `../tsconfig.base.json`, `outDir: dist`, `rootDir: src`, `include: ["src"]`. `e2e/tsconfig.specs.json`: extends it, `noEmit: true`, `rootDir: ".."` (the repo root: specs import `formatValue` and `historyOnly` from `packages/web/src`, and with `rootDir: "."` `tsc` fails with TS6059 even under `noEmit`; checked), `include: ["specs", "test", "playwright.config.ts"]`, `lib: ["ES2022", "DOM"]` (specs pass callbacks to `page.evaluate`).
  - `e2e/vitest.config.ts`: `test.include: ['test/**/*.test.ts']`, `testTimeout: 20_000`.
  - `paths.ts`: compute from `import.meta.url` with `realpathSync`.
  - Root `package.json` scripts: `"test:e2e": "npm run build && npm --prefix e2e test"`. Do not touch `build` or `test`.
  - Ignores per File Structure.
- [ ] **Step 3:** `npm run build && npm --prefix e2e run build && npm --prefix e2e run test:harness` passes; root `npm test` unchanged and passing (it must not list an `e2e` project); `npm run lint`, `npm run format`.
- [ ] **Step 4: Commit** `Add the e2e folder (standalone, outside the workspaces)`.

### Task 2: Fake readings and fake plugins

**Model:** Sonnet. **PR 1.**

**Files:** create `e2e/src/harness/readings.ts`, `e2e/src/harness/fake-collector.ts`, `e2e/src/harness/fake-alerts.ts`, `e2e/test/fakes.test.ts`.

**Interfaces (produced):**

```ts
// readings.ts
export const FAKE_INTERVAL_MS = 1000;
export const DEFAULT_READINGS: Readonly<Record<string, number>>; // D3's table
export const READINGS_ENV = 'PIPULSE_E2E_READINGS'; // path of readings.json, read only by fake-collector
export function writeReadings(path: string, values: Record<string, number | null>): void; // tmp + rename
export function readReadings(path: string): Record<string, number | null>; // {} on ENOENT (no file yet = defaults only); throws `PIPULSE_E2E_READINGS <path>: invalid JSON (<cause>)` on bad JSON or a non-object, never {}
// fake-collector.ts
export * from '@pipulse/collector';
export const builtinPlugins: CollectorPlugin[];
// fake-alerts.ts
export * from '@pipulse/alerts';
export const ALERT_INTERVAL_ENV = 'PIPULSE_E2E_ALERT_INTERVAL_MS';
export const startAlerts: typeof import('@pipulse/alerts').startAlerts;
```

- [ ] **Step 1: Failing tests** (`fakes.test.ts`, importing the TS sources):
  - `DEFAULT_READINGS` has exactly the ids of the real `builtinPlugins` (import the real list) — a new built-in plugin fails this test until it gets a default.
  - Fake `builtinPlugins` match the real ones' `id`, `label`, `unit`, `apiVersion` in order; every `intervalMs` is `FAKE_INTERVAL_MS`; every fake passes `validatePlugin` (from `@pipulse/collector`) with no problems.
  - With `PIPULSE_E2E_READINGS` pointing at a file holding `{ "cpu_load": 55.5, "throttled": null }`: `cpu_load` collects `55.5`, `throttled` collects `null`, `memory_used` (absent) collects `null`. Rewriting the file changes the next `collect()`.
  - `readReadings` of a missing file → `{}`; of a file holding `not json` or `[1]` → throws an error naming the path and saying `invalid JSON`/`not an object` (a corrupt control file must fail at its cause, not turn into silent "no readings"). In the server the fake `collect()` lets that error escape, so the scheduler logs a failed read for that plugin every second; `startServer` attaches `server.logs()` to a failing test (Task 5), so the message is in the report. `setReadings` in the test process reads before it merges, so it throws in the test itself.
  - `writeReadings` leaves no temp file behind and never exposes a partial file (write, then read back in a loop of 200 writes: every read parses).
  - `fake-alerts`'s `startAlerts` passes `intervalMs` from the env (default 1000) and keeps every other option: stub the real one with `vi.mock('@pipulse/alerts', …)` and assert the received options.
- [ ] **Step 2: Implement.** `fake-collector.ts` maps the real `builtinPlugins` imported under another name (`import { builtinPlugins as realPlugins } from '@pipulse/collector'`). Reads are `readFileSync` per `collect()` (small file, local disk).
- [ ] **Step 3:** `npm run build && npm --prefix e2e run build && npm --prefix e2e run test:harness`; lint; format.
- [ ] **Step 4: Commit** `Add fake plugins and a readings control file for e2e`.

### Task 3: The module hook

**Model:** Sonnet builds; **fresh-context review** (Review Focus 1). **PR 1.**

**Files:** create `e2e/src/harness/register.ts`, `e2e/test/register.test.ts`.

- [ ] **Step 1: Failing tests** (`register.test.ts`; build first, the tests spawn processes):
  - A child `node --import <e2e>/dist/harness/register.js <tmp>/probe.mjs` where `probe.mjs` imports `@pipulse/collector` prints the real `builtinPlugins` intervals (not 1000): an importer other than `server.js` is not redirected.
  - A child that runs the real `packages/api/dist/server.js` with the hook (env from Task 4's builder, inline here) serves `/api/config` whose every plugin has `intervalMs` 1000, and `/api/metrics/latest` soon holds `cpu_load` = the value in the readings file (poll with `fetch` until it appears or 10 s pass).
  - Without `module.registerHooks` (simulate by calling the exported `install(moduleApi)` with an object lacking it) → throws the Global Constraints message.
- [ ] **Step 2: Implement.** `register.ts` exports `install(moduleApi)` and calls it with `node:module` at top level. The resolve hook: if `specifier` is `@pipulse/collector` or `@pipulse/alerts` and `context.parentURL === pathToFileURL(SERVER_JS).href`, return `{ url: <fake module URL>, shortCircuit: true }`; otherwise `nextResolve(specifier, context)`.
- [ ] **Step 3:** `npm run build && npm --prefix e2e run build && npm --prefix e2e run test:harness`, lint, format.
- [ ] **Step 4: Commit** `Redirect the server's plugins to fakes under the e2e hook`.

### Task 4: The launcher

**Model:** Sonnet; **fresh-context review** (Review Focus 2, 3). **PR 1.**

**Files:** create `e2e/src/harness/launch.ts`, `e2e/test/launch.test.ts`.

**Interfaces (produced):**

```ts
export interface ServerOptions {
  password?: boolean; // writes admin.hash, sets PIPULSE_ADMIN_PASSWORD_HASH_FILE
  protectReads?: boolean; // PIPULSE_PROTECT_READS=true (needs password)
  alertsFile?: object; // written to <dir>/alerts.json → PIPULSE_ALERTS_FILE
  env?: Record<string, string>; // extra PIPULSE_* only (e.g. PIPULSE_RETENTION_RAW); others refused
  readings?: Record<string, number | null>; // merged over DEFAULT_READINGS
  seed?: (db: PiPulseDb, now: number) => void; // runs before the server starts
  tls?: boolean; // D4's HTTPS set-up
  hook?: boolean; // default true; false only for the drift test
}
export interface RunningServer {
  baseUrl: string;
  port: number;
  dir: string;
  setReadings(values: Record<string, number | null>): void; // merged over current
  stop(): Promise<void>; // SIGTERM, wait, SIGKILL after 5 s
  restart(): Promise<void>; // same dir, same port
  logs(): string; // stdout + stderr so far
}
export const E2E_PASSWORD = 'e2e-password';
export function startServer(options?: ServerOptions): Promise<RunningServer>;
```

- [ ] **Step 1: Failing tests** (`launch.test.ts`):
  - Default: `baseUrl` is `http://127.0.0.1:<port>`; `GET /api/session` → `editable: false`, `protectReads: false`; the database file is inside `dir`; after `stop()` the process has exited.
  - Leak guard: with `process.env.PIPULSE_PROTECT_READS='true'` and `PIPULSE_TLS='on'` set in the test process, a default server still answers `GET /api/config` over HTTP without a session.
  - Drift guard: `startServer({ hook: false })` rejects with a message containing `fake collector not loaded` and leaves no process running.
  - `password: true` → `/api/session` `editable: true`; `POST /api/login` with `E2E_PASSWORD` → 200 with a `pipulse_session` cookie.
  - `restart()` keeps the port and the database (a reading present before is still in `/api/metrics/latest` right after the restart).
  - Missing `packages/web/dist/index.html` (point `paths` at a temp folder through an internal option) → rejects with `run npm run build first`.
  - `env: { PATH: 'x' }` → rejects (only `PIPULSE_*` keys allowed).
- [ ] **Step 2: Implement** per D2/D4. Wait for the `listening on (https?://\S+)` line or process exit (reject with the logs), then check `/api/config` for the fake interval. For `tls: true`, write the files of D4 and verify once with Node `https.get` using `ca: <root-ca.crt>`.
- [ ] **Step 3:** `npm run build && npm --prefix e2e run build && npm --prefix e2e run test:harness`, lint, format.
- [ ] **Step 4: Commit** `Add the e2e server launcher`.

### Task 5: Playwright config, fixtures and the Now-page smoke spec

**Model:** Sonnet. **PR 1.**

**Files:** create `e2e/playwright.config.ts`, `e2e/specs/fixtures.ts`, `e2e/specs/now.e2e.ts`.

- [ ] **Step 1: Install browsers locally** (once, by hand; never scripted): `npx --prefix /Users/seviyon/Repositories/PiPulse/e2e playwright install chromium`.
- [ ] **Step 2: Failing spec** `now.e2e.ts`:
  - Open `/`. The heading level 1 shows the host name; `getByRole('status')` contains `Live`; there is one `region` per plugin label from `/api/config` **except the History-only metrics** (`historyOnly` in `packages/web/src/history.ts`: `load_1`, `swap_io`; `app.tsx` filters them off the Now page), so 11 of the 13 plugins. Derive the expected labels from `/api/config` minus `historyOnly` (a type-only-importing module, imported the same way as `formatValue` below), never a hard-coded count, and assert `Load (1 min)` and `Swap traffic` (the labels of `load_1` and `swap_io`) have no region on the Now page.
  - The `Memory used` region contains the formatted default (`35`; compute the expected text with `formatValue` imported from `packages/web/src/format.ts`, not a hard-coded string).
  - `server.setReadings({ memory_used: 61.5 })` → the same region shows the new value **without a reload** (proves the WebSocket push).
- [ ] **Step 3: Implement.**
  - `playwright.config.ts`: `testDir: 'specs'`, `testMatch: '**/*.e2e.ts'`, settings of D7, `use.timezoneId: 'UTC'`, the two projects of D6 using `devices['Desktop Chrome']`, `reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list'`.
  - `fixtures.ts`: `serverOptions` (option fixture, default `{}`, set per file with `test.use`), `server` (test-scoped: `startServer(serverOptions)`, `use`, then attach `server.logs()` on failure, `stop()`), and `use.baseURL` from `server.baseUrl` (override the `baseURL` fixture). Helper `signIn(page)`: `page.request.post('/api/login', { data: { password: E2E_PASSWORD } })` (shares the context's cookies; no `Origin`, which the hook allows for non-browser clients) — used where sign-in is set-up, not the subject.
- [ ] **Step 4:** `npm --prefix e2e test` passes; lint; format.
- [ ] **Step 5: Commit** `Add the Playwright config, fixtures and the Now page smoke test`.

### Task 6: CI job

**Model:** Sonnet. **PR 1** (ends PR 1).

**Files:** modify `.github/workflows/ci.yml`.

- [ ] **Step 1: Add the job** (actions pinned by digest like the rest of the file; for `actions/cache` and `actions/upload-artifact`, look up the current major's commit SHA at implementation and write `# vN` after it; Renovate's `helpers:pinGitHubActionDigests` keeps them current):

```yaml
e2e:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7
      with:
        node-version: 22.x
        cache: 'npm'
        cache-dependency-path: |
          package-lock.json
          e2e/package-lock.json
    - run: npm ci
    - run: npm ci --prefix e2e
    - run: npm run build
    - name: Playwright version
      id: pw
      run: echo "version=$(npm --prefix e2e exec -- playwright --version | cut -d' ' -f2)" >> "$GITHUB_OUTPUT"
    - uses: actions/cache@<sha> # v<major>
      id: browsers
      with:
        path: ~/.cache/ms-playwright
        key: playwright-${{ runner.os }}-${{ steps.pw.outputs.version }}
    - if: steps.browsers.outputs.cache-hit != 'true'
      run: npm --prefix e2e exec -- playwright install --with-deps chromium
    - if: steps.browsers.outputs.cache-hit == 'true'
      run: npm --prefix e2e exec -- playwright install-deps chromium
    - run: npm --prefix e2e test
    - if: failure()
      uses: actions/upload-artifact@<sha> # v<major>
      with:
        name: e2e
        path: |
          e2e/test-results
          e2e/playwright-report
        retention-days: 7
```

Node 22 only: the Pi ships 22, and running the suite twice adds no browser coverage. The job is 14 steps; on a Playwright bump the cache key changes, so that run downloads the browsers again (Renovate's PR pays it once).

- [ ] **Step 2:** `npx prettier --check .github/workflows/ci.yml`; push the branch; the three `e2e (…)` checks run green next to the existing five.
- [ ] **Step 3: Commit** `Run the e2e suite in CI on Chromium`.
- [ ] **Step 4: Open PR 1** (no release label). PR body says: after merge, the operator adds the required checks (below).

**Operator, after PR 1 merges (an agent can't):** GitHub → repository Settings → Branches (or Rules) → the `main` rule → "Require status checks to pass" → add `e2e` (per Q1). GitHub lists a check only after it has run once on the repository, which PR 1's own runs satisfy.

### Task 7: Reconnecting and back to Live

**Model:** Sonnet. **PR 2.**

**Files:** create `e2e/specs/reconnect.e2e.ts`.

- [ ] **Step 1: Spec:** open `/`, wait for `Live`; `server.stop()` → `getByRole('status')` contains `Reconnecting`; `server.setReadings({ cpu_load: 77 })`, `server.restart()` → status `Live` within 15 s (first retries are 1 s, 2 s, 4 s: `packages/web/src/live.ts`) and the `CPU load` region shows `77` without a reload.
- [ ] **Step 2:** run the suite; if it fails, fix the harness or spec, never add a sleep. Lint, format.
- [ ] **Step 3: Commit** `e2e: the dashboard reconnects after a server restart`.

### Task 8: Sign-in, sign-out and read protection

**Model:** Sonnet builds; **fresh-context review** (auth; Review Focus 5). **PR 2.**

**Files:** create `e2e/specs/auth.e2e.ts`.

- [ ] **Step 1: Specs** (three `test.describe` blocks, each with its own `test.use({ serverOptions })`):
  - _No password:_ Settings (`#/settings`) has no Password field and no `Sign out` button; a `PUT /api/settings` sent from the page with `fetch` (so the browser adds `Origin`) answers `403`.
  - _Password:_ on Settings, type a wrong password → the form's `role="alert"` shows an error and no `Sign out`; type `E2E_PASSWORD` → `Sign out` appears; `context.cookies()` has `pipulse_session` with `httpOnly: true`, `sameSite: 'Strict'`, `secure: false` (plain HTTP); reload keeps it signed in; `Sign out` → the button disappears and the cookie is gone. One wrong attempt only (the limit is 5 per 15 min).
  - _Read protection_ (`password: true, protectReads: true`): `/` shows only the "Sign in to PiPulse" form (no `Pages` nav); in the page, `new WebSocket(<ws url>/api/live)` resolves its `close` event's `code` to `4401` (via `page.evaluate`); `GET /api/config` from the page answers `401`; sign in through the form → the `Pages` nav appears and status reaches `Live`.
- [ ] **Step 2:** `npm --prefix e2e test`; lint; format.
- [ ] **Step 3: Commit** `e2e: sign-in, sign-out and read protection`.

### Task 9: Alerts — raise, acknowledge across tabs, clear, and a rule from the editor

**Model:** Sonnet. **PR 2.**

**Files:** create `e2e/specs/alerts.e2e.ts`.

Server options for this file: `password: true`, `alertsFile: { rules: [{ id: 'e2e_memory', metric: 'memory_used', atLeast: 90, for: '2s', clearAfter: '2s', severity: 'critical', message: 'E2E memory high' }] }` (field names as `parseRuleEntry` in `packages/alerts/src/rules.ts` accepts them; check before writing).

- [ ] **Step 1: Specs:**
  - _Raise, acknowledge, clear:_ tab A and tab B (two pages in one signed-in context) on `#/alerts`. `setReadings({ memory_used: 95 })` → in both tabs, within 15 s, the Open section lists "E2E memory high" and the `Pages` link named like `Alerts, 1 open, critical` exists; on `#/` the `Memory used` region shows an alert line ("Alert since"). Acknowledge in tab A → tab B's Alerts link loses the open count (name back to `Alerts`) without a reload, and the alert stays in Open with "Acknowledged". `setReadings({ memory_used: 40 })` → within 15 s the alert leaves Open and appears under Recent in both tabs.
  - _Rule from the editor:_ signed in, on `#/alerts`, add a rule through the Rules form (labels from `rules-editor.tsx`: id `e2e_cpu`, metric CPU load, at least 50, for `2s`, warning) with the readings already at `cpu_load: 80` → it appears in Open within 15 s with no reload; Disable it → it leaves Open (closed as `rule_removed`).
- [ ] **Step 2:** `npm --prefix e2e test`; lint; format.
- [ ] **Step 3: Commit** `e2e: alerts raise, acknowledge and clear live`.

### Task 10: Settings — retention preview and confirm

**Model:** Sonnet. **PR 2.**

**Files:** create `e2e/specs/settings.e2e.ts`.

- [ ] **Step 1: Specs** (`password: true`, signed in with `signIn`; `seed` writes raw readings for the last 26 h every 60 s for `cpu_load`):
  - Change the raw retention field (label from `LEVEL_LABELS` in `settings-page.tsx`) to `1h`, press `Review changes` → the preview lists the raw level with the deletion icon; `Save` is disabled; tick `I understand this deletes data` → `Save` enabled; Save → the `role="status"` message appears; reload → the field shows `1h`.
  - A non-deleting change (raw `2d` → `3d`) shows no checkbox and saves directly.
  - With `env: { PIPULSE_RETENTION_RAW: '2d' }`, the raw field is locked (disabled, naming the variable).
- [ ] **Step 2:** `npm --prefix e2e test`; lint; format.
- [ ] **Step 3: Commit** `e2e: retention preview and confirmation`.

### Task 11: History — ranges and drag-to-zoom

**Model:** Sonnet. **PR 2.**

**Files:** create `e2e/specs/history.e2e.ts`.

- [ ] **Step 1: Specs** (`seed`: raw readings every 60 s over the last 26 h for `cpu_load`, `memory_used`, `network_rx`, `network_tx`, values from a fixed sine so a chart has shape):
  - `#/history?range=24h` → the `Time range` nav's `24 hours` link has `aria-current="true"`; at least one `img` role named for the CPU chart (names from `packages/web/src/history.ts` groups); no `Couldn't load the history` alert. `7 days`, `30 days` and `1 year` each show a chart (`img` role named for the CPU chart) and neither the `Couldn't load the history` alert **nor** the `No readings in this range` text. Without rollups this would pass vacuously: with 26 h of raw readings every 60 s (1560 rows, over the 1500-point limit), `chooseResolution` picks `1m` for the longer windows and, until housekeeping has written the 1-minute rows, that level is empty, so the page shows `No readings in this range` with no error (checked against `packages/storage/src/rollup.ts`: before housekeeping 7 d/30 d/1 y give `1m` with 0 points; after `runHousekeeping` they give `1h` with 26 points). So the `seed` callback must call `runHousekeeping(db, now)` (exported by `@pipulse/storage`) after inserting the raw rows, which makes the longer ranges resolve to hourly rows deterministically instead of depending on the server's once-a-minute housekeeping.
  - Zoom: set up `page.waitForRequest(/\/api\/metrics\/cpu_load\/series\?/)`, drag across the middle half of the CPU chart's `img` bounding box (`page.mouse.move/down/move/up` with `steps: 10`) → the request's `to - from` is under 24 h, and a `Reset zoom` button appears; press it → it disappears and the `24 hours` link is current again.
- [ ] **Step 2:** `npm --prefix e2e test`; lint; format.
- [ ] **Step 3: Commit** `e2e: history ranges and drag-to-zoom`.

### Task 12: HTTPS project

**Model:** Sonnet builds; **fresh-context review** (TLS; Review Focus 4). **PR 2** (ends PR 2).

**Files:** create `e2e/specs/https/https.e2e.ts`.

- [ ] **Step 1: Specs** (`tls: true, password: true`; file runs only in the `*-https` projects):
  - The launcher's verified Node request passed (else the fixture already failed); `baseURL` is `https://127.0.0.1:<port>`; `/` reaches `Live` (over `wss://`); the `CPU load` region updates after `setReadings`.
  - Sign in → `pipulse_session` has `secure: true`.
  - `page.goto('http://127.0.0.1:<port>/')` → response status `400` and the page shows the text "This PiPulse address uses HTTPS" (from `packages/api/src/plain-http.ts`).
  - Settings → the `Certificate` section names the operator certificate and shows "Valid until" with the year `2125`.
  - Negative check for Review Focus 4: a unit test in `e2e/test/launch.test.ts` (add it here) where `tls: true` is given a chain without `intermediate.crt` → `startServer` rejects with a verification error.
- [ ] **Step 2:** the `chromium-https` project; lint; format.
- [ ] **Step 3: Commit** `e2e: HTTPS dashboard, secure cookie and the plain-HTTP hint`.
- [ ] **Step 4: Open PR 2** (no release label).

### Task 13: Docs

**Model:** Haiku or Sonnet. **PR 3.**

**Files:** modify `README.md`, `docs/PLAN.md`, `CLAUDE.md`.

- [ ] **Step 1:** `README.md`: the Testing row (line with "Playwright (end-to-end, planned)") becomes built, with the pinned version; a "Running the e2e tests" note: `npx --prefix e2e playwright install chromium` once, then `npm run test:e2e`. `docs/PLAN.md`: apply [Spec corrections needed](#spec-corrections-needed). `CLAUDE.md`: replace "Still not built: Playwright end-to-end tests …" with a short status line, and add conventions: "`e2e/` is standalone (not a workspace, not under `packages/`, so packaging never ships it); browsers are installed by hand or by CI, never by an install script"; "the e2e harness swaps the server's plugins through a module hook; nothing under `packages/` may read a `PIPULSE_E2E_*` variable"; "a new built-in plugin needs a default in `e2e/src/harness/readings.ts`"; "e2e specs: role/label locators, web-first assertions, no sleeps, retries 0".
- [ ] **Step 2:** `npm run format`, `npm run lint`.
- [ ] **Step 3: Commit** `Document the e2e suite`.

### Task 14: Exit criterion (manual)

**Model:** an agent writes `docs/superpowers/checklists/2026-10-09-e2e-exit-criterion.md` (new) and **stops**; a person runs it. **PR 3.**

Checklist content:

1. CI: on PR 3, all five existing checks and the three `e2e (…)` checks are green; open one `e2e` job and note its step count and that the browser cache hit on the second run.
2. Mac: from a clean clone, `npm ci`, `npm ci --prefix /Users/seviyon/Repositories/PiPulse/e2e`, `npx --prefix /Users/seviyon/Repositories/PiPulse/e2e playwright install chromium`, `npm run test:e2e` → all pass in Chromium.
3. Break one thing at a time on a scratch branch and watch the right test fail with a useful trace, then revert:
   - `packages/web/src/live.ts`: set `FIRST_RETRY_MS` to 60 000 → only `reconnect.e2e.ts` fails.
   - `packages/api/src/index.ts`: change the `4401` close code to `1000` → `auth.e2e.ts`'s read-protection test fails (and `packages/api` units).
   - `packages/web/src/settings-page.tsx`: drop `disabled={deletes && !confirmed}` from Save → `settings.e2e.ts` fails.
   - `e2e/src/harness/register.ts`: return `nextResolve` unconditionally → every test fails with "fake collector not loaded".
4. Run the suite five times in a row locally (`--repeat-each=5`) → no failure.
5. Greps: `grep -rn "waitForTimeout\|setTimeout" /Users/seviyon/Repositories/PiPulse/e2e/specs` is empty; `grep -rn "PIPULSE_E2E" /Users/seviyon/Repositories/PiPulse/packages` is empty; `npm pack --dry-run` is not used, but `sh packaging/build-tarball.sh 0.0.0-e2e /Users/seviyon/Repositories/tarballs/PiPulse/e2e-check` produces a tarball with no `e2e` folder.
6. Confirm `Io` was not touched.

- [ ] **Step 1:** write the checklist; commit `Add the e2e exit-criterion checklist`; open PR 3; stop.
- [ ] **Step 2 (person):** run it; record the result in `CLAUDE.md` (one paragraph like the phases'), then merge.

---

## Spec corrections needed

Apply to `docs/PLAN.md` in Task 13:

1. "Testing strategy" → End-to-end row: "Playwright (already in your toolbox)" is not accurate for the repo — nothing Playwright exists in it until this plan (the `.playwright-mcp/` ignore entry is for an editor tool, not tests). Replace with "Playwright Test, in the standalone `e2e/` folder; Chromium only, in CI".
2. Same row, "history charts render": uPlot draws to a canvas, so e2e checks that charts load and that drag-to-zoom refetches a narrower window, not what is drawn. Add sign-in/read protection, alerts across tabs, the retention confirm flow and HTTPS to "What it covers".
3. The row implies the suite runs on the real device; it runs against the built server with fake plugins, on CI runners and the Mac. Real-device checks stay the phases' manual exit criteria on `Io`.

Also noted while planning: the task brief pointed at `packaging/test/compose-operator.sh` for certificate set-up; that file does not exist. The plan uses the committed fixtures in `packages/tls/test/fixtures` (made by `make-fixtures.sh`) as `packages/api/test/server.test.ts` does.

## After the tasks

PR 1 merged → operator adds the required checks (Task 6). PR 2 merged → the suite covers every journey in D1. PR 3 → checklist run on CI and the Mac, result recorded in `CLAUDE.md`, `README.md` and `docs/PLAN.md`. No release, no Pi.
