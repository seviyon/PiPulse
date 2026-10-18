# API startup: config, runtime and a thin entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `packages/api` so settings are read in one place (`loadConfig`), the wiring is a testable function (`startServer`), `server.ts` is a thin entry, and `buildServer()`'s inline routes live in route files, with no change in behaviour.

**Architecture:** Two PRs. PR 1 moves code only (feed, options, health/config, metrics, live and the alert list route out of `index.ts`, which becomes a barrel). PR 2 turns `server.ts`'s top-level statements into `loadConfig(env)` plus `startServer(config)` (with the certificate parts in `tls-runtime.ts`) and leaves `server.ts` as the entry.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, `node:sqlite`, Vitest 5, StrykerJS via `npm run mutate`.

**Spec:** `docs/superpowers/specs/2026-10-18-api-config-runtime-design.md` (PR #136). Read it first. Where this plan refines it, the refinement is listed under "Decisions that refine the spec" below.

**Base:** `main` at `ad8f30b`. Line numbers below refer to that commit. Open PRs #132 (web), #133 (collector), #134/#135 (docs, test names) do not touch `packages/api/src`, so the numbers hold; if `packages/api/src/index.ts` or `server.ts` changed since, re-derive them with the `grep` in each task before cutting.

## Global Constraints

Copied from the spec's non-goals and goal, verbatim in meaning:

- No change to any environment variable, message, exit code, log line, route, response or header.
- `dist/server.js` (the systemd `ExecStart`, the installer and the Docker image run it) and `packages/api/package.json`'s `main` (`dist/server.js`) are unchanged; so are the exported names of the package.
- Existing route files (`alert-routes`, `auth-routes`, `notify-routes`, `settings-routes`, `updates-routes`) stay where they are; there is no `routes/` folder.
- `packages/tls`, `collector`, `alerts`, `notify` and `storage` are not touched.
- No classes or dependency-injection framework: functions and plain objects. (The one small class is `StartupError`, see below.)
- The order of Fastify hooks and of `app.register(...)` calls is behaviour: keep it.
- Coverage is collected per package: tests for code in `packages/api` live in `packages/api/test`.

## Decisions that refine the spec

1. **`StartupError` exists** (spec open question 1 said "plain `Error`"). Today three kinds of failure end the process differently: `fail()` prints `[pipulse] <message>` for refusals, `listen` errors (for instance `EADDRINUSE`) print the whole error object, and anything unexpected crashes with Node's own output. To keep all three exactly as they are, refusals are `StartupError`s (`export class StartupError extends Error {}` in `config.ts`) and the entry prints `[pipulse] <message>` only for those.
2. **`startServer(config, overrides?)`** takes an optional second argument `{ plugins?: CollectorPlugin[]; device?: DeviceInfo; shutdownTimeoutMs?: number }`. Production passes none. In-process tests use it so that they do not poll the real system, call `systeminformation`, or wait 5 s for a hung read.
3. **`GET /api/alerts` (the list) moves into `alert-routes.ts`**, not a new file: it is an alerts route, that file already exists, and the spec said existing files stay. Its schema moves with it.
4. **Warnings are returned, not printed, by `loadConfig`** (`config.warnings: string[]`, each already prefixed `[pipulse] warning: …`), and `startServer` prints them first. A refusal now prints fewer warnings before it than today (never more); the 12 spawned-process tests assert one stderr line for refusals, which still holds.

5. **When several settings are bad at once, the first one reported may differ from today's**, because `loadConfig` checks all of its own settings before the certificate is loaded (for instance `PIPULSE_TLS=on` with no certificate and `PIPULSE_TLS_HSTS=forever` printed "leaf.pem: file not found" before; now the HSTS line comes first). Each message is unchanged; there is still exactly one line and exit code 1.
6. **Spec question 2 is decided: yes, retention is validated early.** `retentionFromEnv(env)` and the runtime's `resolveRetention` apply the same rule (`env[variable] !== undefined` goes to `parseDuration(variable, value)`) and give identical messages (checked on the base commit for `10m`, `nope`, the empty string and `0d`), so `loadConfig` calls it.
7. **`createRuntimeStatus` takes an injectable `identity`** (default `processIdentity(process.pid)`, which is `undefined` off Linux), so its tests run the same on a Mac and in CI.

## Review Focus

The inputs and conditions the spec implies but the obvious tests would miss, most likely first. Each has a test in the task that owns the code.

1. **A refusal must come before anything exists on disk or on the network.** A bad `PIPULSE_ALLOWED_HOSTS`, `PIPULSE_RETENTION_*`, certificate or rules file: no `pipulse.sqlite` file, no port bound, no webhook delivery started. (Task 8, 10)
2. **A failure part-way through startup must not leak.** A bad rules file or a port in use after the database is open must close the database and stop what already started, because the test process (unlike today's `process.exit`) keeps running. (Task 10)
3. **An expired certificate still starts** (the `SEVERE` line), and a mismatched pair still stops with the same one line. (Task 9)
4. **`stop()` twice, `stop()` during a hung read.** A second call returns the same result; a read that never settles gives `drained: false` after 5 s and `stop()` does not hang. (Task 10)
5. **The three failure outputs stay distinct** (refusal line, whole-error listen failure, unexpected crash). (Task 11)

## File structure

```text
packages/api/src/
  index.ts          CHANGED (PR1): the barrel only
  app.ts            NEW (PR1): buildServer()
  options.ts        NEW (PR1): ServerOptions, PluginInfo, DeviceInfo
  feed.ts           NEW (PR1): Feed, LiveFeed, createFeed, createLiveFeed
  health-routes.ts  NEW (PR1): /health, /api/health, /api/config
  metrics-routes.ts NEW (PR1): /api/metrics/latest, history, series (+ the raw cap and schemas)
  live-routes.ts    NEW (PR1): /api/live and the dashboard's static files
  alert-routes.ts   CHANGED (PR1): + GET /api/alerts
  config.ts         NEW (PR2): StartupError, PiPulseConfig, loadConfig
  tls-runtime.ts    NEW (PR2): certificate load, reloader, runtime status file, alert context
  runtime.ts        NEW (PR2): startServer
  server.ts         CHANGED (PR2): the thin entry
packages/api/test/
  app-surface.test.ts NEW (PR1): pins the exports and the routes
  config.test.ts      NEW (PR2)
  tls-runtime.test.ts NEW (PR2)
  runtime.test.ts     NEW (PR2)
```

## Working rules for every task

- **Verbatim moves are made with a script, never retyped.** Each move task gives `sed -n 'A,Bp'` ranges; paste the result and change only the lines the task lists. After each PR run the **removed-lines check** (Task 7, Step 5 and Task 12, Step 5): every line removed from `index.ts` / `server.ts` must appear in a new file or be one the task lists as dropped.
- **Before every push** (the project rule, see `CLAUDE.md`): (1) changed-line coverage from `packages/api`'s own run; (2) `npm run mutate` on the new logic, on a copy of the repo (`cp -cR`), every survivor killed or argued equivalent in the PR; (3) `npm test`, `npm run lint`, `npx prettier --write` on changed files. For PR 2 also the packaging suite and `npm run test:e2e` (both start the built server).
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

# PR 1 — routes and barrel (branch `api-routes-barrel`)

### Task 1: Pin the package's surface before anything moves

**Files:**

- Create: `packages/api/test/app-surface.test.ts`

**Interfaces:**

- Consumes: `buildServer`, `createFeed`, `createLiveFeed` from `../src/index.js`.
- Produces: a test that must pass unchanged at the end of PR 1.

- [ ] **Step 1: Cut the branch**

```bash
git checkout main && git pull -q && git checkout -b api-routes-barrel
```

- [ ] **Step 2: Write the test (it passes on today's code)**

```ts
import { describe, expect, it } from 'vitest';
import { createRuleSource } from '@pipulse/alerts';
import { builtinPlugins } from '@pipulse/collector';
import { openDb } from '@pipulse/storage';
import * as api from '../src/index.js';

// What the package exports (types are erased), as of the refactor's base commit.
const EXPORTS = [
  'buildServer',
  'createFeed',
  'createLiveFeed',
  'healthBody',
  'longestLookBack',
  'rawRetentionProblem',
  'readGeneratedExtras',
  'tlsView'
];

// `printRoutes` with every optional module on: the tree, sorted, so the order routes are
// registered in does not matter (the order of hooks and plugins does, and other tests cover it).
const FULL_ROUTES = [
  '* (HEAD, GET)',
  '/api/alerts (GET, HEAD)',
  '/api/config (GET, HEAD)',
  '/api/health (GET, HEAD)',
  '/api/live (GET, HEAD)',
  '/api/login (POST)',
  '/api/logout (POST)',
  '/api/metrics/:id/history (GET, HEAD)',
  '/api/metrics/:id/series (GET, HEAD)',
  '/api/metrics/latest (GET, HEAD)',
  '/api/notify (GET, HEAD)',
  '/api/session (GET, HEAD)',
  '/api/settings (GET, HEAD, PUT)',
  '/api/updates (GET, HEAD)',
  '/health (GET, HEAD)',
  '/check (POST)',
  '/:id (PUT, DELETE)',
  '/:id/acknowledge (POST)',
  '/preview (POST)',
  '/rules (GET, HEAD, POST)'
];

const MINIMAL_ROUTES = [
  '/api/alerts (GET, HEAD)',
  '/api/config (GET, HEAD)',
  '/api/health (GET, HEAD)',
  '/api/login (POST)',
  '/api/logout (POST)',
  '/api/metrics/:id/history (GET, HEAD)',
  '/api/metrics/:id/series (GET, HEAD)',
  '/api/metrics/latest (GET, HEAD)',
  '/api/notify (GET, HEAD)',
  '/api/session (GET, HEAD)',
  '/api/updates (GET, HEAD)',
  '/health (GET, HEAD)',
  '/check (POST)',
  '/:id/acknowledge (POST)'
];

/** The route lines of `printRoutes`, without the tree drawing, sorted. */
function routeLines(tree: string): string[] {
  return tree
    .split('\n')
    .map((line) => line.replace(/^[│├└─\s]+/u, '').trim())
    .filter((line) => line !== '')
    .sort();
}

describe('the api package surface', () => {
  it('exports exactly these names', () => {
    expect(Object.keys(api).sort()).toEqual(EXPORTS);
  });

  it('registers exactly these routes when every optional module is on', async () => {
    const db = openDb(':memory:');
    const rules = createRuleSource(db, {
      cores: 4,
      metrics: builtinPlugins.map(({ id, intervalMs }) => ({ id, intervalMs })),
      rawRetention: () => ({ ms: 172_800_000, text: '2d' }),
      onProblem: () => {}
    });
    const app = api.buildServer(db, {
      live: api.createLiveFeed(),
      alertFeed: api.createFeed(),
      alertRules: { source: rules, recheck: () => {} },
      settings: { getRetention: () => ({}) as never, metrics: [], rawAtLeast: () => 0 },
      notify: { status: () => [] },
      webRoot: '/tmp',
      auth: { protectReads: false }
    });
    await app.ready();
    expect(routeLines(app.printRoutes({ commonPrefix: false }))).toEqual([...FULL_ROUTES].sort());
    await app.close();
    db.close();
  });

  it('registers exactly these routes with no options', async () => {
    const db = openDb(':memory:');
    const app = api.buildServer(db);
    await app.ready();
    expect(routeLines(app.printRoutes({ commonPrefix: false }))).toEqual(
      [...MINIMAL_ROUTES].sort()
    );
    await app.close();
    db.close();
  });
});
```

- [ ] **Step 3: Run it; expect PASS (a characterization test)**

Run: `npx vitest run packages/api/test/app-surface.test.ts`
Expected: 3 passed. If a route line differs (for instance the wildcard `* (HEAD, GET)` prints differently), print the tree with `app.printRoutes({ commonPrefix: false })` once and correct the constants to what the _unmodified_ code prints; the point is to pin today's behaviour, not to guess it.

- [ ] **Step 4: Mutation check that the test notices**

Temporarily delete the line `app.get('/health', async () => ({ status: 'ok' }));` from `packages/api/src/index.ts`, run the test, expect FAIL on both route tests, then `git checkout packages/api/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/api/test/app-surface.test.ts
git add packages/api/test/app-surface.test.ts
git commit -m "api: pin the package's exports and routes before moving code

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `feed.ts` and `options.ts`

**Files:**

- Create: `packages/api/src/feed.ts`, `packages/api/src/options.ts`
- Modify: `packages/api/src/index.ts`

**Interfaces:**

- Produces: `feed.ts` exports `Feed<T>`, `LiveFeed`, `createFeed`, `createLiveFeed`; `options.ts` exports `PluginInfo`, `DeviceInfo`, `ServerOptions`. `index.ts` still exports every name it exports today (and now re-exports these).

- [ ] **Step 1: Create `feed.ts` (verbatim from `index.ts:69-100`)**

```bash
{
  printf "import type { Sample } from '@pipulse/storage';\n\n"
  sed -n '69,100p' packages/api/src/index.ts
} > packages/api/src/feed.ts
```

Check the top of the file reads `/** An in-process publish/subscribe channel…` after the import, and that it ends with the closing brace of `createLiveFeed`.

- [ ] **Step 2: Create `options.ts` (verbatim from `index.ts:47-67` and `102-163`)**

```bash
{
  cat <<'EOF'
import type { AlertEvent, Rule } from '@pipulse/alerts';
import type { WebhookStatus } from '@pipulse/notify';
import type { RetentionPolicy } from '@pipulse/storage';
import type { AlertRulesOptions } from './alert-routes.js';
import type { AuthOptions } from './auth-routes.js';
import type { Feed, LiveFeed } from './feed.js';
import type { Health } from './health.js';
import type { SettingsOptions } from './settings-routes.js';
import type { TlsView } from './tls-status.js';
import type { Updates } from './updates.js';
import type { NodeSupport } from './version.js';

EOF
  sed -n '47,67p' packages/api/src/index.ts
  echo
  sed -n '102,163p' packages/api/src/index.ts
} > packages/api/src/options.ts
```

Check: `sed -n '160,165p' packages/api/src/index.ts` shows that line 163 is the closing `}` of `ServerOptions` (the `/** The largest frame…` comment starts at 164 and must not be copied).

- [ ] **Step 3: Edit `index.ts`**

Delete lines 47-100 (the `PluginInfo`, `DeviceInfo`, `Feed`, `LiveFeed`, `createFeed`, `createLiveFeed` definitions) and 102-163 (`ServerOptions`). Add near the top of the file, after the existing `export type { AuthOptions }…` lines:

```ts
export type { DeviceInfo, PluginInfo, ServerOptions } from './options.js';
export { createFeed, createLiveFeed, type Feed, type LiveFeed } from './feed.js';
import { createFeed, createLiveFeed } from './feed.js';
import type { Feed } from './feed.js';
import type { ServerOptions } from './options.js';
```

(`buildServer` still uses `createFeed`, `Feed` and `ServerOptions`, so they are also imported locally; the barrel in Task 7 drops the local imports.)

- [ ] **Step 4: Verify**

Run: `npm run build 2>&1 | tail -5 && npx vitest run packages/api 2>&1 | grep -E "Test Files|Tests |FAIL|×"`
Expected: builds, all `packages/api` tests pass, including `app-surface.test.ts`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/api/src/feed.ts packages/api/src/options.ts packages/api/src/index.ts
git add packages/api/src
git commit -m "api: feed and option types in their own files

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `metrics-routes.ts`

**Files:**

- Create: `packages/api/src/metrics-routes.ts`
- Modify: `packages/api/src/index.ts`

**Interfaces:**

- Consumes: `ServerOptions` (`options.ts`).
- Produces: `export function registerMetricsRoutes(app: FastifyInstance, db: PiPulseDb, options: Pick<ServerOptions, 'settings' | 'retention'>): void`.

- [ ] **Step 1: Create the file**

```bash
{
  cat <<'EOF'
import type { FastifyInstance } from 'fastify';
import {
  chooseResolution,
  getHistory,
  getLatest,
  getSeries,
  MAX_RAW_ROWS,
  policyOf,
  rawRowsExceed,
  type PiPulseDb,
  type Resolution
} from '@pipulse/storage';
import type { ServerOptions } from './options.js';

EOF
  sed -n '166,167p' packages/api/src/index.ts     # TOO_MANY_RAW and its comment
  echo
  sed -n '174,196p' packages/api/src/index.ts     # HistoryQuery, historyQuerySchema, seriesQuerySchema
  cat <<'EOF'

/** The metric readings: the newest of each, raw history, and rolled-up series. */
export function registerMetricsRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: Pick<ServerOptions, 'settings' | 'retention'>
): void {
EOF
  sed -n '297,346p' packages/api/src/index.ts
  echo '}'
} > packages/api/src/metrics-routes.ts
```

Check: `sed -n '295,299p;344,349p' packages/api/src/index.ts` — line 297 is `app.get('/api/metrics/latest'…`, and 346 is the `);` that closes the `/series` route (the `/api/alerts` route starts at 348).

- [ ] **Step 2: Edit `index.ts`**

Delete lines 166-167, 174-196 and 297-346; in their place inside `buildServer` (where line 297 was) insert `registerMetricsRoutes(app, db, options);` and add `import { registerMetricsRoutes } from './metrics-routes.js';` to the imports. Remove imports that are now unused (ESLint names them in Step 3).

- [ ] **Step 3: Verify**

Run: `npm run lint 2>&1 | tail -15` (fix any `no-unused-vars` import it names, in `index.ts` only), then `npm run build 2>&1 | tail -3 && npx vitest run packages/api 2>&1 | grep -E "Test Files|Tests |FAIL|×"`
Expected: all pass (`series.test.ts`, `raw-cap.test.ts`, `routes.test.ts` exercise these routes).

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/api/src
git add packages/api/src
git commit -m "api: the metrics routes in their own file

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `health-routes.ts`

**Files:**

- Create: `packages/api/src/health-routes.ts`
- Modify: `packages/api/src/index.ts`

**Interfaces:**

- Produces: `export function registerHealthRoutes(app: FastifyInstance, db: PiPulseDb, options: ServerOptions): void` — registers `/health`, `/api/health`, `/api/config`. The defaults for `plugins` and `device` (today `index.ts:261-266`) move in with it, because only `/api/config` uses them.

- [ ] **Step 1: Create the file**

```bash
{
  cat <<'EOF'
import { uptime } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { hostName } from '@pipulse/tls';
import type { PiPulseDb } from '@pipulse/storage';
import { createHealth } from './health.js';
import type { ServerOptions } from './options.js';
import { healthBody, type TlsView } from './tls-status.js';
import { nodeSupport } from './version.js';

/** The liveness, health and config routes. */
export function registerHealthRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: ServerOptions
): void {
EOF
  sed -n '261,266p' packages/api/src/index.ts     # plugins and device defaults
  echo
  sed -n '268,295p' packages/api/src/index.ts     # /health ... /api/config
  echo '}'
} > packages/api/src/health-routes.ts
```

Check: `sed -n '259,268p;293,297p' packages/api/src/index.ts` — 261-266 are the `const plugins = …` and `const device = …` statements, 268 is `app.get('/health'…`, 295 is the `}));` ending `/api/config`.

- [ ] **Step 2: Edit `index.ts`**

Delete lines 261-266 and 268-295 and insert `registerHealthRoutes(app, db, options);` where line 268 was; import it; remove now-unused imports (`uptime`, `hostName`, `createHealth`, `healthBody`, `nodeSupport`, `TlsView` type if unused — the lint run names them).

- [ ] **Step 3: Verify**

Run: `npm run lint 2>&1 | tail -8 && npm run build 2>&1 | tail -3 && npx vitest run packages/api 2>&1 | grep -E "Test Files|Tests |FAIL|×"`
Expected: all pass (`health.test.ts`, `routes.test.ts`, `https.test.ts` cover these).

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/api/src
git add packages/api/src
git commit -m "api: the health and config routes in their own file

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `GET /api/alerts` into `alert-routes.ts`

**Files:**

- Modify: `packages/api/src/alert-routes.ts`, `packages/api/src/index.ts`

- [ ] **Step 1: Copy the schema and the route**

In `alert-routes.ts`: add `import { listAlerts } from '@pipulse/alerts';` (merge with its existing `@pipulse/alerts` import if there is one), paste `alertsQuerySchema` (`index.ts:197-206`) above `registerAlertRoutes`, and paste the route (`index.ts:348-367`, from `app.get<{` to its closing `});`) as the first statement inside `registerAlertRoutes`, before the `app.post<{ Params: { id: number } }>('/api/alerts/:id/acknowledge'…` block.

```bash
sed -n '197,206p' packages/api/src/index.ts     # alertsQuerySchema
sed -n '348,367p' packages/api/src/index.ts     # the route
```

- [ ] **Step 2: Remove from `index.ts`**

Delete lines 197-206 and 348-367 from `index.ts`; the existing `registerAlertRoutes(app, db, …)` call stays where it is (registration order of these two routes does not matter, and the pinned route tree is sorted).

- [ ] **Step 3: Verify, commit**

Run: `npm run lint 2>&1 | tail -8 && npm run build 2>&1 | tail -3 && npx vitest run packages/api 2>&1 | grep -E "Test Files|Tests |FAIL|×"` — expected all pass (`alert-routes.test.ts`, `alerts.test.ts`).

```bash
npx prettier --write packages/api/src
git add packages/api/src
git commit -m "api: GET /api/alerts beside the other alert routes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `live-routes.ts`

**Files:**

- Create: `packages/api/src/live-routes.ts`
- Modify: `packages/api/src/index.ts`

**Interfaces:**

- Consumes: `registerAuth` (its return type), `Feed`, `Notice` (from `alert-routes.ts`).
- Produces:
  - `export interface LiveDeps { auth: ReturnType<typeof registerAuth>; notices: Feed<Notice>; allowedOrigins: string[] }`
  - `export function registerLiveRoutes(app, db, options: Pick<ServerOptions, 'live' | 'alertFeed' | 'alertRules' | 'heartbeatMs' | 'maxBufferedBytes'>, deps: LiveDeps): void`
  - `export function registerDashboard(app, webRoot: string | undefined): void`

- [ ] **Step 1: Create the file**

```bash
{
  cat <<'EOF'
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { openAlerts } from '@pipulse/alerts';
import { getLatest, type PiPulseDb } from '@pipulse/storage';
import type { Notice } from './alert-routes.js';
import type { registerAuth } from './auth-routes.js';
import type { Feed } from './feed.js';
import { isAllowedOrigin } from './origin.js';
import type { ServerOptions } from './options.js';

EOF
  sed -n '164,165p' packages/api/src/index.ts     # MAX_CLIENT_FRAME_BYTES and its comment
  sed -n '171,172p' packages/api/src/index.ts     # DEFAULT_HEARTBEAT_MS, DEFAULT_MAX_BUFFERED_BYTES
  cat <<'EOF'

export interface LiveDeps {
  auth: ReturnType<typeof registerAuth>;
  notices: Feed<Notice>;
  allowedOrigins: string[];
}

/** The /api/live WebSocket: a snapshot on connect, then samples, alerts, rule edits and notices. */
export function registerLiveRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: Pick<
    ServerOptions,
    'live' | 'alertFeed' | 'alertRules' | 'heartbeatMs' | 'maxBufferedBytes'
  >,
  { auth, notices, allowedOrigins }: LiveDeps
): void {
EOF
  sed -n '378,463p' packages/api/src/index.ts     # const live = … through the closing brace of `if (live) {…}`
  cat <<'EOF'
}

/** The built dashboard, served after every API route is registered; omitted = API only. */
export function registerDashboard(app: FastifyInstance, webRoot: string | undefined): void {
EOF
  sed -n '465,467p' packages/api/src/index.ts     # if (options.webRoot) { … }
  echo '}'
} > packages/api/src/live-routes.ts
```

Then in the new file replace `options.webRoot` with `webRoot` in the static block. Check the cut points: `sed -n '376,380p;461,469p' packages/api/src/index.ts` — 378 is `const live = options.live;`, 463 is the `}` closing `if (live) {`, 465-467 are `if (options.webRoot) { void app.register(fastifyStatic, …) }`.

- [ ] **Step 2: Edit `index.ts`**

Delete lines 164-165, 171-172, 378-467 and, where the removed blocks were, insert (in this order, after `if (options.settings) registerSettingsRoutes(...)`):

```ts
registerLiveRoutes(app, db, options, { auth, notices, allowedOrigins });
registerDashboard(app, options.webRoot);
```

Add the import `import { registerDashboard, registerLiveRoutes } from './live-routes.js';` and remove imports that are no longer used (`websocket`, `fastifyStatic`, `openAlerts`, `isAllowedOrigin`, …; lint names them).

- [ ] **Step 3: Verify**

Run: `npm run lint 2>&1 | tail -8 && npm run build 2>&1 | tail -3 && npx vitest run packages/api 2>&1 | grep -E "Test Files|Tests |FAIL|×"`
Expected: all pass (`live.test.ts`, `server.test.ts`, `static.test.ts`, `auth-routes.test.ts` cover this; `app-surface.test.ts` still shows `/api/live`).

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/api/src
git add packages/api/src
git commit -m "api: the live feed and the dashboard's files in their own file

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `app.ts`, the barrel, and PR 1's gates

**Files:**

- Create: `packages/api/src/app.ts` (a `git mv` of what is left of `index.ts`)
- Modify: `packages/api/src/index.ts` (now the barrel), `docs/architecture.md`

**Interfaces:**

- Produces: `app.ts` exports `buildServer(db, options)`. `index.ts` exports exactly the names in `EXPORTS` of Task 1.

- [ ] **Step 1: Move what is left of `index.ts` to `app.ts`**

```bash
git mv packages/api/src/index.ts packages/api/src/app.ts
```

In `app.ts`, delete every `export … from` re-export block and the local `export type`/`export {…}` lines added in Task 2 (they move to the barrel), keeping the imports `buildServer` needs.

- [ ] **Step 2: Create the barrel `index.ts`**

```ts
export { buildServer } from './app.js';
export { createFeed, createLiveFeed, type Feed, type LiveFeed } from './feed.js';
export type { DeviceInfo, PluginInfo, ServerOptions } from './options.js';
export type { AuthOptions } from './auth-routes.js';
export type { AlertRulesOptions } from './alert-routes.js';
export { longestLookBack, rawRetentionProblem, type SettingsOptions } from './settings-routes.js';
export {
  healthBody,
  readGeneratedExtras,
  tlsView,
  type GeneratedExtras,
  type MetadataProblem,
  type TlsView
} from './tls-status.js';
```

- [ ] **Step 3: Verify**

Run: `npm run lint 2>&1 | tail -8 && npm run build 2>&1 | tail -3 && npm test 2>&1 | grep -E "Test Files|Tests |FAIL|×"`
Expected: build passes (the compiler finds any export missing from the barrel), `app-surface.test.ts` passes unchanged, 2060+ tests pass.

- [ ] **Step 4: Architecture note**

In `docs/architecture.md`, replace the sentence that describes the API ("a Fastify server exposes REST endpoints…") with one that adds: "`app.ts` builds the Fastify app and registers the route modules (`health-routes`, `metrics-routes`, `alert-routes`, `notify-routes`, `updates-routes`, `settings-routes`, `live-routes`); `index.ts` is the package's exports."

- [ ] **Step 5: The removed-lines check**

```bash
git diff -U0 main -- packages/api/src/app.ts packages/api/src/index.ts | grep '^-' | grep -v '^---' | sed 's/^-//' \
  | sed 's/^[[:space:]]*//' | grep -v '^$' | sort -u > /tmp/removed.txt
cat packages/api/src/{app,feed,options,health-routes,metrics-routes,live-routes,alert-routes,index}.ts \
  | sed 's/^[[:space:]]*//' | sort -u > /tmp/present.txt
comm -23 /tmp/removed.txt /tmp/present.txt
```

Expected: only import lines, the `registerX` call sites that now take arguments, and `export` keyword changes. Anything else is code that went missing: stop and find it.

- [ ] **Step 6: The pre-push gates**

1. Coverage: `npx vitest run packages/api --coverage --coverage.reporter=json`, then check every added line in `packages/api/src` is covered (use the saved script `changed-coverage.py api`, or read `coverage/coverage-final.json`); delete `coverage/`.
2. Mutation: the new files are moved code and are exercised by existing tests; run `npm run mutate -- api src/metrics-routes.ts test/series.test.ts test/raw-cap.test.ts test/routes.test.ts --bail=1` on a copy of the repo and kill or argue every survivor (survivors inherited from the moved code are reported, not fixed here).
3. `npx prettier --write packages/api docs/architecture.md`, `npm run lint`, `npm test`.
4. `npm run test:e2e` (needs `npx --prefix e2e playwright install chromium` once) and the packaging suite (`packaging/test/run.sh service install`) in the `node:22-bookworm-slim` container as in the TLS PRs (copy the repo without `node_modules`, `npm ci`, `npm run build`).

- [ ] **Step 7: Commit, push, PR (no release label)**

```bash
git add -A packages docs
git commit -m "api: buildServer in app.ts, index.ts is the barrel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push -q -u origin api-routes-barrel
gh pr create --title "api: routes in their own files, index.ts is the barrel" --body "<what moved, the removed-lines check output, gates run>"
```

---

# PR 2 — config and runtime (branch `api-config-runtime`, cut from `main` after PR 1 merges)

### Task 8: `config.ts`

**Files:**

- Create: `packages/api/src/config.ts`, `packages/api/test/config.test.ts`

**Interfaces:**

- Produces:
  - `export class StartupError extends Error { override name = 'StartupError'; }`
  - `export interface PiPulseConfig` (below) and `export function loadConfig(env: NodeJS.ProcessEnv): PiPulseConfig`.
- Behaviour: reads and validates; every failure is a `StartupError` whose message is exactly the line `server.ts` printed after `[pipulse] `; no I/O except what `readAuthConfig`, `readTlsConfig` and `readVersion` already do.

- [ ] **Step 1: Capture the oracle: every refusal line, from the running code**

The `REFUSALS` table in Step 2 was captured from the base commit with the loop below (macOS has no `timeout`; `perl -e 'alarm 5; exec @ARGV'` stands in). Re-run it before writing the table, correct any row that differs, and add the cases `server.test.ts` already asserts:

```bash
npm run build >/dev/null
run() { d=$(mktemp -d); env -i PATH="$PATH" PIPULSE_DB_PATH=$d/p.sqlite PIPULSE_HOST=127.0.0.1 PIPULSE_PORT=0 \
  PIPULSE_TLS_DIR=$d/tls "$@" perl -e 'alarm 5; exec @ARGV' node --disable-warning=ExperimentalWarning \
  packages/api/dist/server.js 2>&1 | head -2; ls $d | tr '\n' ' '; echo; rm -rf $d; }
run PIPULSE_TLS=off PIPULSE_PORT=abc
run PIPULSE_TLS=off PIPULSE_ALLOWED_HOSTS=bad_name   # also lists p.sqlite: today the database exists by then
run PIPULSE_TLS=off PIPULSE_RETENTION_RAW=10m        # same: a refusal that comes after the database is open
```

(`PIPULSE_PORT=abc` overrides the earlier `PIPULSE_PORT=0` because it comes later in `env`'s arguments.) Add every refusal `server.test.ts` already asserts. The table's expected messages are copied from this output, not written from memory.

- [ ] **Step 2: Write the failing test**

`packages/api/test/config.test.ts`:

```ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REFUSE_LINE } from '@pipulse/tls';
import { loadConfig, StartupError } from '../src/config.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const base = (): NodeJS.ProcessEnv => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-config-'));
  return {
    PIPULSE_DB_PATH: join(dir, 'p.sqlite'),
    PIPULSE_TLS: 'off',
    PIPULSE_TLS_DIR: join(dir, 'tls')
  };
};

describe('loadConfig', () => {
  it('reads the defaults', () => {
    const config = loadConfig(base());
    expect(config.port).toBe(8889);
    expect(config.host).toBe('0.0.0.0');
    expect(config.allowedOrigins).toEqual([]);
    expect(config.allowedHosts).toEqual([]);
    expect(config.inContainer).toBe(false);
    expect(config.hstsSeconds).toBeUndefined();
    expect(config.tls.mode).toBe('http');
    expect(config.auth.protectReads).toBe(false);
  });

  it('reads every setting it owns', () => {
    const config = loadConfig({
      ...base(),
      PIPULSE_HOST: '127.0.0.1',
      PIPULSE_PORT: '0',
      PIPULSE_ALLOWED_ORIGINS: ' https://a.lan , ,https://b.lan ',
      PIPULSE_ALLOWED_HOSTS: 'io.lan',
      PIPULSE_IN_CONTAINER: 'true',
      PIPULSE_HOST_ROOT: '/host',
      PIPULSE_WEB_DIR: '/srv/web',
      PIPULSE_RUNTIME_DIR: '/run/x',
      PIPULSE_ALERTS_FILE: '/a.json',
      PIPULSE_NOTIFY_FILE: '/n.json'
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: ['https://a.lan', 'https://b.lan'],
      inContainer: true,
      hostRoot: '/host',
      webDir: '/srv/web',
      runtimeDir: '/run/x',
      alertsFile: '/a.json',
      notifyFile: '/n.json'
    });
    expect(config.allowedHosts).toContain('io.lan');
  });

  it('turns an empty PIPULSE_PORT into 8889 and keeps the rest of the table', () => {
    expect(loadConfig({ ...base(), PIPULSE_PORT: '' }).port).toBe(8889);
  });

  it('puts the TLS warnings in `warnings`, already prefixed, and prints nothing', () => {
    const config = loadConfig({
      ...base(),
      PIPULSE_TLS_CERT: '/x.pem',
      PIPULSE_TLS_KEY: '/x.key'
    });
    expect(config.warnings).toContain(
      '[pipulse] warning: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY are set but HTTPS is off (set PIPULSE_TLS=on)'
    );
  });

  it('leaves nothing behind: no database, no TLS folder, no file at all', () => {
    const env = base();
    loadConfig(env);
    expect(readdirSync(dir)).toEqual([]);
  });
});

// Every refusal, as the running server prints it after "[pipulse] ". Copied from Step 1's output.
const REFUSALS: Array<{ name: string; env: Record<string, string>; message: RegExp }> = [
  {
    name: 'a port that is not a number',
    env: { PIPULSE_PORT: 'abc' },
    message: /^PIPULSE_PORT must be a port number from 0 to 65535, not "abc"$/
  },
  {
    name: 'an allowed host that is not a host name',
    env: { PIPULSE_ALLOWED_HOSTS: 'bad_name' },
    message:
      /^PIPULSE_ALLOWED_HOSTS: "bad_name" is not a host name \(no ports, schemes or wildcards\)$/
  },
  {
    name: 'raw retention of 10m (minutes or months?)',
    env: { PIPULSE_RETENTION_RAW: '10m' },
    message:
      /^PIPULSE_RETENTION_RAW must be a duration like 30s, 5min, 36h, 14d, 2w, 1y or forever \(got "10m"\)$/
  },
  {
    name: 'one-minute retention that is not a duration',
    env: { PIPULSE_RETENTION_1M: 'nope' },
    message:
      /^PIPULSE_RETENTION_1M must be a duration like 30s, 5min, 36h, 14d, 2w, 1y or forever \(got "nope"\)$/
  },
  {
    name: 'PIPULSE_PROTECT_READS that is not a boolean',
    env: { PIPULSE_PROTECT_READS: 'maybe' },
    message: /^PIPULSE_PROTECT_READS must be true or false \(got "maybe"\)$/
  },
  {
    name: 'a password hash file that cannot be read',
    env: { PIPULSE_ADMIN_PASSWORD_HASH_FILE: '/nonexistent' },
    message: /^PIPULSE_ADMIN_PASSWORD_HASH_FILE \/nonexistent could not be read: ENOENT$/
  },
  {
    name: 'PIPULSE_TLS that is neither on nor off',
    env: { PIPULSE_TLS: 'bogus' },
    message: /^PIPULSE_TLS must be "on" or "off", not "bogus"$/
  },
  {
    name: 'an HSTS duration of forever (HTTPS on)',
    env: { PIPULSE_TLS: 'on', PIPULSE_TLS_HSTS: 'forever' },
    message: /^PIPULSE_TLS_HSTS must be a finite duration, not forever$/
  }
];

describe('loadConfig refuses with one line', () => {
  for (const { name, env, message } of REFUSALS) {
    it(name, () => {
      let error: unknown;
      try {
        loadConfig({ ...base(), ...env });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StartupError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain('\n');
    });
  }

  it('refuses a release default with neither a certificate nor PIPULSE_TLS=off', () => {
    const env = base();
    delete env['PIPULSE_TLS'];
    expect(() => loadConfig(env)).toThrow(REFUSE_LINE);
  });
});
```

The `REFUSALS` rows are filled from Step 1's captured output before the test is run; an empty table is a failed step, not an acceptable state.

- [ ] **Step 3: Run it; expect FAIL** (`Cannot find module '../src/config.js'`)

Run: `npx vitest run packages/api/test/config.test.ts`

- [ ] **Step 4: Write `config.ts`**

```ts
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RUNTIME_DIR,
  RELEASE_DEFAULT,
  hostName,
  listenHost,
  listenPort,
  readTlsConfig,
  type TlsConfig
} from '@pipulse/tls';
import { retentionFromEnv } from '@pipulse/storage';
import { parseDuration } from '@pipulse/storage/duration';
import { readAuthConfig, type AuthConfig } from './auth.js';
import { parseAllowedHosts } from './host.js';
import { nodeSupport, readVersion, type NodeSupport } from './version.js';

/** A setting the operator got wrong: the message is the one line printed after `[pipulse] `. */
export class StartupError extends Error {
  override name = 'StartupError';
}

/** Runs `read`, turning whatever it throws into a StartupError with the same message. */
export function refuse<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new StartupError(error instanceof Error ? error.message : String(error));
  }
}

export interface PiPulseConfig {
  dbPath: string;
  host: string;
  port: number;
  webDir: string;
  allowedOrigins: string[];
  /** PIPULSE_ALLOWED_HOSTS, with the host's own names added when it is set; empty = no check. */
  allowedHosts: string[];
  inContainer: boolean;
  hostRoot?: string;
  auth: AuthConfig;
  tls: TlsConfig;
  hstsSeconds?: number;
  runtimeDir: string;
  /** Paths only: the files are read by startServer. */
  alertsFile?: string;
  notifyFile?: string;
  version: string;
  node: NodeSupport;
  /** The environment, for the retention source (it also needs the database). */
  env: NodeJS.ProcessEnv;
  /** Lines to print before anything else, each already `[pipulse] warning: …`. */
  warnings: string[];
}

/** PIPULSE_TLS_HSTS in seconds, or undefined; HTTPS only (HSTS ignores ports). */
function readHsts(env: NodeJS.ProcessEnv, tls: TlsConfig, warnings: string[]): number | undefined {
  const text = env['PIPULSE_TLS_HSTS']?.trim();
  if (!text) return undefined;
  if (tls.mode !== 'https') {
    warnings.push('[pipulse] PIPULSE_TLS_HSTS is ignored: HTTPS is off');
    return undefined;
  }
  const ms = parseDuration('PIPULSE_TLS_HSTS', text);
  if (!Number.isFinite(ms)) {
    throw new Error('PIPULSE_TLS_HSTS must be a finite duration, not forever');
  }
  return Math.floor(ms / 1000);
}

/**
 * Reads and validates every setting the server takes from the environment. Throws a StartupError
 * (one line) for the first bad one; has no side effects: nothing is created, opened or printed.
 */
export function loadConfig(env: NodeJS.ProcessEnv): PiPulseConfig {
  const warnings: string[] = [];
  const auth = refuse(() => readAuthConfig(env));
  const tls = refuse(() => readTlsConfig(env, { releaseDefault: RELEASE_DEFAULT }));
  for (const warning of tls.warnings) warnings.push(`[pipulse] warning: ${warning}`);
  if (tls.mode !== 'https' && (env['PIPULSE_TLS_CERT']?.trim() || env['PIPULSE_TLS_KEY']?.trim())) {
    warnings.push(
      '[pipulse] warning: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY are set but HTTPS is off (set PIPULSE_TLS=on)'
    );
  }
  const port = refuse(() => listenPort(env));
  // The database is not open yet; startServer merges the saved values in. A bad
  // PIPULSE_RETENTION_* is refused here, before anything is opened (decision 6).
  refuse(() => retentionFromEnv(env));
  const hstsSeconds = refuse(() => readHsts(env, tls, warnings));
  const allowedHosts = refuse(() =>
    parseAllowedHosts(env['PIPULSE_ALLOWED_HOSTS'], [
      hostName(),
      `${hostName()}.local`,
      ...tls.names
    ])
  );
  const hostRoot = env['PIPULSE_HOST_ROOT'];
  const alertsFile = env['PIPULSE_ALERTS_FILE'];
  const notifyFile = env['PIPULSE_NOTIFY_FILE'];
  return {
    dbPath: env['PIPULSE_DB_PATH'] ?? 'pipulse.sqlite',
    host: listenHost(env),
    port,
    webDir: env['PIPULSE_WEB_DIR'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
    allowedOrigins: (env['PIPULSE_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
    allowedHosts,
    inContainer: env['PIPULSE_IN_CONTAINER'] === 'true',
    ...(hostRoot ? { hostRoot } : {}),
    auth,
    tls,
    ...(hstsSeconds !== undefined ? { hstsSeconds } : {}),
    runtimeDir: env['PIPULSE_RUNTIME_DIR']?.trim() || DEFAULT_RUNTIME_DIR,
    ...(alertsFile ? { alertsFile } : {}),
    ...(notifyFile ? { notifyFile } : {}),
    // The app root is three levels above packages/api/dist/server.js; a release stamps version.json there.
    version: readVersion(fileURLToPath(new URL('../../../', import.meta.url))),
    node: nodeSupport(),
    env,
    warnings
  };
}
```

Two things to verify against today's code before moving on (a short note in the PR for each): (a) `PIPULSE_HOST_ROOT=""` is falsy and today's `HOST_ROOT ? {…} : {}` ignores it, as above; (b) `readVersion`/`nodeSupport` take the same arguments as in `server.ts:115-116`. The early `PIPULSE_RETENTION_*` check is decision 6; the `REFUSALS` rows for `10m` and `nope` below pin that the message is the one the running server prints today.

- [ ] **Step 5: Run it; expect PASS**, then the gates for this task

Run: `npx vitest run packages/api/test/config.test.ts` → all pass.
Coverage of `config.ts` from `packages/api`'s own run (every line and branch, including the HSTS-off warning, the finite-duration refusal and the `PIPULSE_HOST_ROOT` branches: add the cases the coverage report names). Mutation: `npm run mutate -- api src/config.ts test/config.test.ts --bail=1` on a copy; kill every survivor.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/api
git add packages/api
git commit -m "api: loadConfig reads and validates every setting, with no side effects

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `tls-runtime.ts`

**Files:**

- Create: `packages/api/src/tls-runtime.ts`, `packages/api/test/tls-runtime.test.ts`

**Interfaces:**

- Consumes: `PiPulseConfig`, `StartupError`, `refuse` (Task 8).
- Produces:

```ts
export function loadServingCertificate(tls: TlsConfig): LoadedCertificate | undefined; // throws StartupError
export function certificateAlertContext(
  tls: TlsConfig,
  provider: () => CertificateProvider | undefined
): () => AlertContext;
export interface RuntimeStatusWriter {
  publish(): void;
}
export function createRuntimeStatus(options: {
  runtimeDir: string;
  certificate: LoadedCertificate | undefined;
  provider: () => CertificateProvider | undefined;
  warn: (message: string) => void;
  /** Default: processIdentity(process.pid), which is undefined off Linux (then nothing is written). */
  identity?: () => { startTime: string; bootId: string } | undefined;
}): RuntimeStatusWriter;
export function startCertificateReloader(options: {
  tls: TlsConfig;
  certificate: LoadedCertificate;
  initialSignature: string | undefined;
  apply: (cert: LoadedCertificate) => void;
  log: (message: string) => void;
  onChange: () => void;
}): CertificateProvider;
export function initialSignatureOf(tls: TlsConfig): string | undefined;
```

- [ ] **Step 1: Write the failing tests** (`packages/api/test/tls-runtime.test.ts`)

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_DEFAULT, readTlsConfig, type CertificateProvider } from '@pipulse/tls';
import { StartupError } from '../src/config.js';
import {
  certificateAlertContext,
  createRuntimeStatus,
  initialSignatureOf,
  loadServingCertificate,
  startCertificateReloader
} from '../src/tls-runtime.js';
import { fixture } from '../../tls/test/helpers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-tlsrt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** TLS settings for an operator certificate written under `dir`; the clock counts as synchronized. */
function operator(cert: string, key: string, extra: Record<string, string> = {}) {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  const timesync = join(dir, 'timesync');
  writeFileSync(certPath, cert);
  writeFileSync(keyPath, key, { mode: 0o600 });
  mkdirSync(timesync, { recursive: true });
  writeFileSync(join(timesync, 'synchronized'), '');
  return readTlsConfig(
    {
      PIPULSE_TLS: 'on',
      PIPULSE_TLS_CERT: certPath,
      PIPULSE_TLS_KEY: keyPath,
      PIPULSE_TLS_TIMESYNC_DIR: timesync,
      PIPULSE_TLS_DIR: join(dir, 'tls'),
      ...extra
    },
    { releaseDefault: RELEASE_DEFAULT }
  );
}
const good = () => operator(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf.key'));
const expired = (extra: Record<string, string> = {}) =>
  operator(
    fixture('under-expired.crt') + fixture('expired-intermediate.crt'),
    fixture('under-expired.key'),
    extra
  );
const stubProvider = (
  cert: NonNullable<ReturnType<typeof loadServingCertificate>>
): CertificateProvider => ({
  current: () => cert,
  reload: () => ({ state: 'ok', lastAttempt: null, lastError: null }),
  poll: () => {},
  stop: () => {}
});

describe('loadServingCertificate', () => {
  it('loads an operator certificate and describes it', () => {
    const cert = loadServingCertificate(good());
    expect(cert?.source).toBe('operator');
    expect(cert?.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  it('refuses a key that does not match, with the line the process prints', () => {
    const tls = operator(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf2.key'));
    expect(() => loadServingCertificate(tls)).toThrow(StartupError);
    expect(() => loadServingCertificate(tls)).toThrow(
      /the private key does not match the first certificate$/
    );
  });

  it('starts, with a SEVERE line, for an expired chain', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadServingCertificate(expired())).toBeDefined();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('[pipulse] SEVERE: the HTTPS certificate is expired')
    );
  });

  it('refuses an expired chain with PIPULSE_TLS_REQUIRE_VALID_CERT=true', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      loadServingCertificate(expired({ PIPULSE_TLS_REQUIRE_VALID_CERT: 'true' }))
    ).toThrow(/the HTTPS certificate is expired and PIPULSE_TLS_REQUIRE_VALID_CERT=true$/);
  });

  it('has nothing to load over plain HTTP', () => {
    const tls = readTlsConfig(
      { PIPULSE_TLS: 'off', PIPULSE_TLS_DIR: join(dir, 'tls') },
      { releaseDefault: RELEASE_DEFAULT }
    );
    expect(loadServingCertificate(tls)).toBeUndefined();
  });
});

describe('createRuntimeStatus', () => {
  const identity = () => ({ startTime: '12345', bootId: 'boot-1' });

  it('writes the status file of a plain HTTP server', () => {
    createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => undefined,
      warn: () => {},
      identity
    }).publish();
    const written = JSON.parse(readFileSync(join(dir, 'tls-status.json'), 'utf8'));
    expect(written).toMatchObject({
      version: 1,
      transport: 'http',
      certificate: null,
      pid: process.pid,
      startTime: '12345',
      bootId: 'boot-1'
    });
  });

  it('reports the certificate and its reload state for an HTTPS server', () => {
    const cert = loadServingCertificate(good())!;
    createRuntimeStatus({
      runtimeDir: dir,
      certificate: cert,
      provider: () => stubProvider(cert),
      warn: () => {},
      identity
    }).publish();
    const written = JSON.parse(readFileSync(join(dir, 'tls-status.json'), 'utf8'));
    expect(written.transport).toBe('https');
    expect(written.certificate).toMatchObject({
      source: 'operator',
      fingerprint: cert.fingerprint,
      notAfter: cert.notAfter,
      reload: { state: 'ok' }
    });
  });

  it('writes nothing, and does not throw, when the folder does not exist', () => {
    const missing = join(dir, 'absent');
    createRuntimeStatus({
      runtimeDir: missing,
      certificate: undefined,
      provider: () => undefined,
      warn: () => {},
      identity
    }).publish();
    expect(existsSync(missing)).toBe(false);
  });

  it('writes nothing without a process identity (off Linux)', () => {
    createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => undefined,
      warn: () => {},
      identity: () => undefined
    }).publish();
    expect(existsSync(join(dir, 'tls-status.json'))).toBe(false);
  });

  it('warns once, not on every publish, when the file cannot be written', () => {
    mkdirSync(join(dir, 'tls-status.json')); // a folder where the file goes: the rename fails, even as root
    const warn = vi.fn();
    const status = createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => undefined,
      warn,
      identity
    });
    status.publish();
    status.publish();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(`could not write ${dir}/tls-status.json`);
  });
});

describe('certificateAlertContext', () => {
  it('is empty without a provider', () => {
    expect(certificateAlertContext(good(), () => undefined)()).toEqual({});
  });

  it('carries the expiry and that the clock is synchronized', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    expect(certificateAlertContext(tls, () => stubProvider(cert))()).toEqual({
      certificate: { notAfter: cert.notAfter, clockSynced: true }
    });
  });

  it('says the clock is not synchronized when it is not', () => {
    const tls = good();
    rmSync(join(dir, 'timesync', 'synchronized'));
    const cert = loadServingCertificate(tls)!;
    const context = certificateAlertContext(tls, () => stubProvider(cert))();
    expect(context.certificate?.clockSynced).toBe(false);
  });

  it("passes a generated certificate's start date to the clock check", () => {
    const tls = good();
    const cert = { ...loadServingCertificate(tls)!, source: 'generated' as const };
    const context = certificateAlertContext(tls, () => stubProvider(cert))();
    expect(context.certificate?.notAfter).toBe(cert.notAfter);
  });
});

describe('startCertificateReloader', () => {
  it('swaps in a replaced certificate through apply and tells onChange', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    const apply = vi.fn();
    const onChange = vi.fn();
    const provider = startCertificateReloader({
      tls,
      certificate: cert,
      initialSignature: initialSignatureOf(tls),
      apply,
      log: () => {},
      onChange
    });
    writeFileSync(join(dir, 'cert.pem'), fixture('leaf2.crt') + fixture('intermediate.crt'));
    writeFileSync(join(dir, 'key.pem'), fixture('leaf2.key'), { mode: 0o600 });
    provider.poll();
    provider.poll(); // a change must look the same on two polls
    expect(apply).toHaveBeenCalledTimes(1);
    expect(provider.current().fingerprint).not.toBe(cert.fingerprint);
    expect(onChange).toHaveBeenCalled();
    provider.stop();
  });

  it('keeps the certificate it has when the replacement does not match its key', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    const apply = vi.fn();
    const log = vi.fn();
    const provider = startCertificateReloader({
      tls,
      certificate: cert,
      initialSignature: initialSignatureOf(tls),
      apply,
      log,
      onChange: () => {}
    });
    writeFileSync(join(dir, 'key.pem'), fixture('leaf2.key'), { mode: 0o600 });
    provider.poll();
    provider.poll();
    expect(apply).not.toHaveBeenCalled();
    expect(provider.current().fingerprint).toBe(cert.fingerprint);
    expect(log).toHaveBeenCalled();
    provider.stop();
  });
});
```

If a fixture pair does not behave as described (for instance `leaf2` is refused as a replacement), the test wins: choose the pair `packages/tls/test/replacement.test.ts` uses for a good replacement and note the change in the commit message.

- [ ] **Step 2: Run; expect FAIL** (module not found).

- [ ] **Step 3: Write `tls-runtime.ts`** by moving, with the listed edits only:

| Function                   | Source (base commit `server.ts`)                                                             | Edits                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadServingCertificate`   | `loadActive` (162-166), `certPaths` (167-171) used as internals; `readCertificate` (174-203) | take `tls: TlsConfig`; `TLS` → `tls`; `fail(error)` → `throw new StartupError(...)` via `refuse`; the two `fail(\`the HTTPS certificate is …\`)`lines throw`new StartupError(...)`with the same text;`return undefined`when`tls.mode !== 'https' \|\| !tls.source` |
| `initialSignatureOf`       | `INITIAL_SIGNATURE` (172-173)                                                                | a function of `tls`                                                                                                                                                                                                                                                |
| `certificateAlertContext`  | `certificateContext` (317-329)                                                               | takes `tls` and `provider()`                                                                                                                                                                                                                                       |
| `createRuntimeStatus`      | `publishRuntime` (331-362) with `RUNTIME_DIR`, `IDENTITY`, `runtimeWarned`                   | state held in the closure; `CERT` → the `certificate` argument; the warning goes through `warn`                                                                                                                                                                    |
| `startCertificateReloader` | the `if (CERT && TLS.source) { … startReloader({…}) }` block (424-451)                       | returns the provider; `app.server` is reached only through the `apply` callback passed in                                                                                                                                                                          |

Copy the bodies with `sed -n` ranges, then make only those edits. `generatedOwner`/`loadCertificate` options stay as in `loadActive`.

- [ ] **Step 4: Run; expect PASS.** Gates: changed-line coverage of `tls-runtime.ts` from `packages/api`'s run; `npm run mutate -- api src/tls-runtime.ts test/tls-runtime.test.ts --bail=1` on a copy; kill every survivor.

- [ ] **Step 5: Commit** (`api: the certificate parts of startup in tls-runtime.ts`).

---

### Task 10: `runtime.ts`

**Files:**

- Create: `packages/api/src/runtime.ts`, `packages/api/test/runtime.test.ts`

**Interfaces:**

- Consumes: `PiPulseConfig`, `StartupError`, `refuse`; everything from `tls-runtime.ts`; `buildServer`, `createFeed`, `createLiveFeed`, `longestLookBack`, `rawRetentionProblem` (`./app.js`, `./feed.js`, `./settings-routes.js`).
- Produces:

```ts
export interface StartOverrides {
  plugins?: CollectorPlugin[];
  device?: DeviceInfo;
  /** How long stop() waits for in-flight sensor reads; default SHUTDOWN_TIMEOUT_MS (5000). */
  shutdownTimeoutMs?: number;
}
export const SHUTDOWN_TIMEOUT_MS = 5000;
export interface RunningServer {
  app: FastifyInstance;
  address(): { host: string; port: number };
  /** Idempotent: every call returns the same promise. */
  stop(): Promise<{ drained: boolean }>;
}
export async function startServer(
  config: PiPulseConfig,
  overrides?: StartOverrides
): Promise<RunningServer>;
```

- [ ] **Step 1: Write the failing tests** (`packages/api/test/runtime.test.ts`)

```ts
import { connect, createServer } from 'node:net';
import { request } from 'node:https';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectorPlugin } from '@pipulse/collector';
import { loadConfig, StartupError } from '../src/config.js';
import { startServer, type RunningServer } from '../src/runtime.js';
import { fixture } from '../../tls/test/helpers.js';

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-runtime-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const plugin = (collect: () => Promise<number | null> = async () => 1): CollectorPlugin => ({
  id: 'cpu_load',
  label: 'CPU load',
  unit: '%',
  intervalMs: 50,
  apiVersion: 1,
  collect
});
const device = { hostname: 'test', platform: 'linux', arch: 'arm' };

const settings = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PIPULSE_DB_PATH: join(dir, 'p.sqlite'),
  PIPULSE_HOST: '127.0.0.1',
  PIPULSE_PORT: '0',
  PIPULSE_TLS: 'off',
  PIPULSE_TLS_DIR: join(dir, 'tls'),
  PIPULSE_RUNTIME_DIR: join(dir, 'run'),
  PIPULSE_WEB_DIR: join(dir, 'no-dashboard'),
  ...extra
});
const start = async (
  extra: Record<string, string> = {},
  plugins: CollectorPlugin[] = [plugin()],
  more: { shutdownTimeoutMs?: number } = {}
) => {
  const server = await startServer(loadConfig(settings(extra)), { plugins, device, ...more });
  running.push(server);
  return server;
};
const httpsSettings = (cert: string, key: string, extra: Record<string, string> = {}) => {
  writeFileSync(join(dir, 'cert.pem'), cert);
  writeFileSync(join(dir, 'key.pem'), key, { mode: 0o600 });
  mkdirSync(join(dir, 'timesync'), { recursive: true });
  writeFileSync(join(dir, 'timesync', 'synchronized'), '');
  return {
    PIPULSE_TLS: 'on',
    PIPULSE_TLS_CERT: join(dir, 'cert.pem'),
    PIPULSE_TLS_KEY: join(dir, 'key.pem'),
    PIPULSE_TLS_TIMESYNC_DIR: join(dir, 'timesync'),
    ...extra
  };
};
const goodHttps = (extra: Record<string, string> = {}) =>
  httpsSettings(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf.key'), extra);
/** GET over HTTPS, verifying against the fixtures' root (as https.test.ts does), never skipping it. */
const trustedJson = (port: number, path: string) =>
  new Promise<unknown>((resolve, reject) => {
    request(
      {
        host: '127.0.0.1',
        port,
        path,
        ca: fixture('root-ca.crt'),
        servername: 'localhost',
        agent: false
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve(JSON.parse(body)));
      }
    )
      .on('error', reject)
      .end();
  });
/** Whether something accepts TCP connections on the port (for a chain a client would refuse). */
const accepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startServer', () => {
  it('starts over HTTP, serves its routes, and stops cleanly', async () => {
    const server = await start();
    const { host, port } = server.address();
    expect(port).toBeGreaterThan(0);
    expect(await (await fetch(`http://${host}:${port}/health`)).json()).toEqual({ status: 'ok' });
    const config = (await (await fetch(`http://${host}:${port}/api/config`)).json()) as {
      plugins: Array<{ id: string }>;
    };
    expect(config.plugins.map((p) => p.id)).toEqual(['cpu_load']);
    await expect(server.stop()).resolves.toEqual({ drained: true });
    await expect(fetch(`http://${host}:${port}/health`)).rejects.toThrow();
  });

  it('starts over HTTPS, writes the data-folder marker, and reports the transport', async () => {
    const server = await start(goodHttps());
    const health = (await trustedJson(server.address().port, '/api/health')) as {
      transport: string;
    };
    expect(health.transport).toBe('https');
    expect(existsSync(join(dir, 'tls-installed'))).toBe(true);
  });

  it('says so, loudly, when the data-folder marker cannot be written', async () => {
    mkdirSync(join(dir, 'tls-installed')); // a folder where the marker file goes
    await start(goodHttps());
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('[pipulse] ERROR:');
  });

  it('starts, with a SEVERE line, with an expired certificate', async () => {
    const server = await start(
      httpsSettings(
        fixture('under-expired.crt') + fixture('expired-intermediate.crt'),
        fixture('under-expired.key')
      )
    );
    // A client would refuse the expired chain, so check that the port is open, not a response.
    expect(await accepts(server.address().port)).toBe(true);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      '[pipulse] SEVERE: the HTTPS certificate is expired'
    );
  });

  it('prints the config warnings before anything else', async () => {
    await start({ PIPULSE_TLS_CERT: '/x.pem', PIPULSE_TLS_KEY: '/x.key' });
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toBe(
      '[pipulse] warning: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY are set but HTTPS is off (set PIPULSE_TLS=on)'
    );
  });

  it('stops once however often it is asked, with the same answer', async () => {
    const server = await start();
    const first = server.stop();
    const second = server.stop();
    expect(second).toBe(first);
    expect(await first).toEqual({ drained: true });
  });

  it('stops collecting when it is stopped', async () => {
    let calls = 0;
    const server = await start({}, [
      plugin(async () => {
        calls++;
        return 1;
      })
    ]);
    await wait(200);
    expect(calls).toBeGreaterThan(1);
    await server.stop();
    const after = calls;
    await wait(300);
    expect(calls).toBe(after);
  });

  it('does not wait for a read that never settles: drained is false', async () => {
    const server = await start({}, [plugin(() => new Promise<number | null>(() => {}))], {
      shutdownTimeoutMs: 50
    });
    await expect(server.stop()).resolves.toEqual({ drained: false });
  });

  it.skipIf(process.platform !== 'linux')(
    'writes the runtime status file once it listens',
    async () => {
      mkdirSync(join(dir, 'run'));
      await start(goodHttps());
      expect(existsSync(join(dir, 'run', 'tls-status.json'))).toBe(true);
    }
  );
});

describe('startServer refuses before anything exists', () => {
  it('a certificate that does not match its key: no database, no port', async () => {
    const env = httpsSettings(
      fixture('leaf.crt') + fixture('intermediate.crt'),
      fixture('leaf2.key')
    );
    await expect(start(env)).rejects.toBeInstanceOf(StartupError);
    expect(existsSync(join(dir, 'p.sqlite'))).toBe(false);
  });

  it.each([
    ['PIPULSE_ALLOWED_HOSTS', { PIPULSE_ALLOWED_HOSTS: 'bad_name' }],
    ['PIPULSE_RETENTION_RAW', { PIPULSE_RETENTION_RAW: '10m' }]
  ])('a bad %s is refused by loadConfig, with nothing created', (_name, env) => {
    expect(() => loadConfig(settings(env))).toThrow(StartupError);
    expect(existsSync(join(dir, 'p.sqlite'))).toBe(false);
  });
});

describe('startServer cleans up after a failure part-way through', () => {
  it('a rules file that cannot be read: StartupError, and the database is closed', async () => {
    await expect(start({ PIPULSE_ALERTS_FILE: join(dir, 'missing.json') })).rejects.toThrow(
      /^PIPULSE_ALERTS_FILE .* could not be read: ENOENT$/
    );
    // The last connection closing is what removes the write-ahead log.
    expect(existsSync(join(dir, 'p.sqlite-wal'))).toBe(false);
  });

  it('a webhook file that cannot be read: StartupError, and the database is closed', async () => {
    await expect(start({ PIPULSE_NOTIFY_FILE: join(dir, 'missing.json') })).rejects.toThrow(
      /^PIPULSE_NOTIFY_FILE .* could not be read: ENOENT$/
    );
    expect(existsSync(join(dir, 'p.sqlite-wal'))).toBe(false);
  });

  it('raw retention too short for the built-in rules is refused', async () => {
    await expect(start({ PIPULSE_RETENTION_RAW: '1min' })).rejects.toBeInstanceOf(StartupError);
    expect(existsSync(join(dir, 'p.sqlite-wal'))).toBe(false);
  });

  it('a port already in use: the original listen error, and whatever started is stopped', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const taken = (holder.address() as { port: number }).port;
    let calls = 0;
    const error: unknown = await start({ PIPULSE_PORT: String(taken) }, [
      plugin(async () => {
        calls++;
        return 1;
      })
    ]).catch((caught: unknown) => caught);
    holder.close();
    expect((error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
    expect(error).not.toBeInstanceOf(StartupError);
    const after = calls;
    await wait(300);
    expect(calls).toBe(after); // the scheduler it had started is stopped
    expect(existsSync(join(dir, 'p.sqlite-wal'))).toBe(false);
  });
});
```

The built-in rules' longest look-back exceeds one minute, which is why `PIPULSE_RETENTION_RAW=1min` is refused; if `rawRetentionProblem` accepts it, use the smallest value the `server.test.ts` retention case uses. If `-wal` is not removed on a clean close on some filesystem, use `new DatabaseSync(file)` plus `PRAGMA locking_mode` to prove the lock is free instead, and say so in the commit.

- [ ] **Step 2: Run; expect FAIL** (module not found).

- [ ] **Step 3: Write `runtime.ts`.** The order and bodies are `server.ts` lines 66-545, restructured as follows. Copy bodies with `sed -n`, listing every edit:

```ts
export async function startServer(config: PiPulseConfig, overrides: StartOverrides = {}): Promise<RunningServer> {
  for (const warning of config.warnings) console.warn(warning);             // 1. printed first (spec decision 4)
  const plugins = overrides.plugins ?? builtinPlugins;
  const { run: runPlugins, unavailable } = splitForContainer(plugins, config.inContainer);   // 73-78
  const metrics = plugins.map(({ id, intervalMs }) => ({ id, intervalMs }));                 // 80
  const runMetrics = runPlugins.map(({ id, intervalMs }) => ({ id, intervalMs }));           // 83

  const certificate = loadServingCertificate(config.tls);                    // 2. refusal here = nothing opened
  const initialSignature = initialSignatureOf(config.tls);                   //    read BEFORE the load? see note

  const parts: Parts = { db: openDb(config.dbPath) };                         // 3. from here, failures clean up
  try {
    …lines 226-306 (retention, rules, raw check, webhooks, notifications, health), 308-315 (feeds, tls holder),
      364-376 (marker holder, engine holder, updates), 389-422 (device, buildServer options)…
    parts.app = app; …start reloader, housekeeping, scheduler, alerts (424-493), assigning each into `parts`…
    await app.listen({ port: config.port, host: config.host });             // 4. listen
  } catch (error) {
    await stopParts(parts);                                                   //    undo, then rethrow as is
    throw error;
  }
  …post-listen block (the body of `.then(() => {…})`, 497-543) …
  return { app, address, stop };
}
```

Edits to the copied bodies, complete list:

- `fail(error)` → `throw error` inside the existing `try/catch` (each `readX` becomes `refuse(() => …)`); the `RAW_PROBLEM` line becomes `if (problem) throw new StartupError(problem)`.
- `process.env[...]` → `config.env[...]`; `DB_PATH`, `HOST`, `PORT`, `ALLOWED_ORIGINS`, `WEB_DIR`, `VERSION`, `NODE`, `HOSTROOT`, `AUTH`, `TLS`, `HSTS_SECONDS`, `ALLOWED_HOSTS`, `RUNTIME_DIR`, `IN_CONTAINER` → the matching `config.*` field.
- `builtinPlugins` → `plugins` (the override) where `server.ts` lists plugins, in `METRICS`/`RUN_METRICS`, in the notification metric list and in the `/api/config` plugin list.
- `readDeviceInfo` call (390-393) → `overrides.device ?? { …await readDeviceInfo(…), hostname: hostName() }`.
- The `app.server` reloader `apply` callback stays a closure over `app` (it is created after `buildServer`).
- The `engine` and `tls` late-bound holders (313, 365) stay as objects, unchanged.
- The `.catch((error) => { console.error(error); process.exit(1) })` on `listen` is removed (the entry decides); the `.then` body becomes the code after `await app.listen`.
- `shutdown()` (549-574) becomes `stopParts(parts)` in this order and no other: `parts.provider?.stop()`, `parts.housekeeping?.stop()`, `parts.alerts?.stop()`, `parts.updates?.stop()`, then `Promise.all([parts.app?.close(), parts.scheduler?.stop(5000) ?? true, parts.notifications?.stop()])`, then `parts.db.close()`, returning `{ drained }`. The two `console.error` lines about a second signal and about undrained collections move to the entry (Task 11).
- `stop` is `let stopping: Promise<{ drained: boolean }> | undefined; stop = () => (stopping ??= stopParts(parts))`.

Note on `INITIAL_SIGNATURE`: today it is computed _before_ the certificate load, so a renewal landing between the two is still picked up; `initialSignatureOf(config.tls)` must keep being called before `loadServingCertificate`, as in the sketch's order if the two lines are swapped. Do it in that order.

- [ ] **Step 4: Run; expect PASS.** Gates: changed-line coverage of `runtime.ts` from `packages/api`'s own run (every branch: HTTPS and HTTP, the container branch of `splitForContainer`, `webDir` present and absent, marker written and refused, the failure paths); `npm run mutate -- api src/runtime.ts test/runtime.test.ts --bail=1` on a copy (this is the long run; use `--bail=1`, an idle machine); kill every survivor or argue it equivalent in the PR.

- [ ] **Step 5: Commit** (`api: startServer, the wiring as a function that returns a handle`).

---

### Task 11: the thin `server.ts`

**Files:**

- Modify: `packages/api/src/server.ts` (rewritten)

- [ ] **Step 1: Replace the whole file with**

```ts
import type { AddressInfo } from 'node:net';
import { loadConfig, StartupError } from './config.js';
import { startServer, type RunningServer } from './runtime.js';

/**
 * PiPulse server: one process that runs the collector scheduler and serves the REST API plus the
 * /api/live WebSocket. Shuts down cleanly on SIGINT/SIGTERM (systemd and `docker stop` both send
 * SIGTERM). The settings are read by loadConfig and the wiring is startServer's; this file only
 * decides what the process prints and which code it exits with.
 */

/** Refusals print one `[pipulse]` line; anything else (a listen failure, a crash) prints whole. */
function fail(error: unknown): never {
  if (error instanceof StartupError) console.error(`[pipulse] ${error.message}`);
  else console.error(error);
  process.exit(1);
}

let running: RunningServer;
try {
  running = await startServer(loadConfig(process.env));
} catch (error) {
  fail(error);
}
void (running.app.server.address() as AddressInfo);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  // Our handlers replace Node's default terminate-on-signal, so a second
  // Ctrl-C/SIGTERM must still be able to kill a shutdown that is stuck.
  if (shuttingDown) {
    console.error('[pipulse] second signal received, exiting immediately');
    process.exit(1);
  }
  shuttingDown = true;
  const { drained } = await running.stop();
  if (!drained) {
    console.error('[pipulse] collections still running after 5000 ms, exiting without them');
    // A hung read may still hold the event loop open; don't wait on it.
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}
```

Remove the stray `void (running.app.server.address() as AddressInfo);` line and the `AddressInfo` import if nothing else needs them (they are only a reminder that `address()` exists; the post-listen log inside `startServer` already prints the address). The `5000 ms` in the message is `runtime.ts`'s exported `SHUTDOWN_TIMEOUT_MS`: import it and interpolate it (`${SHUTDOWN_TIMEOUT_MS} ms`) so the two cannot drift.

- [ ] **Step 2: Run everything that starts the real file**

```bash
npm run build && npx vitest run packages/api/test/server.test.ts
```

Expected: all 12 spawned-process tests pass unchanged (refusal lines, one stderr line, exit code 1; the port-in-use test; the allowed-hosts tests).

- [ ] **Step 3: Add the three-outputs test** to `server.test.ts` (Review Focus 5): a case that holds a port with a plain `net` server and starts the built file on it, asserting stderr is the whole error (contains `EADDRINUSE`, does **not** start with `[pipulse]`), and exit code 1. Run it on `main`'s built server first to confirm that is today's output, then on the branch.

- [ ] **Step 4: Commit** (`api: server.ts is the entry: load, start, signals, exit codes`).

---

### Task 12: PR 2's gates and the PR

- [ ] **Step 1: The removed-lines check**, as in Task 7 Step 5, over `server.ts`'s base content:

```bash
git show main:packages/api/src/server.ts | sed 's/^[[:space:]]*//' | grep -v '^$' | sort -u > /tmp/removed.txt
cat packages/api/src/{server,config,tls-runtime,runtime}.ts | sed 's/^[[:space:]]*//' | sort -u > /tmp/present.txt
comm -23 /tmp/removed.txt /tmp/present.txt
```

Expected: only lines the Task 9/10 edit tables list (the `fail(...)` calls, the `process.env[...]` and constant reads, the `.then/.catch` wrapper, the imports). Anything else is missing code.

- [ ] **Step 2: Coverage.** `npx vitest run packages/api --coverage --coverage.reporter=json`, every added line in `config.ts`, `tls-runtime.ts`, `runtime.ts` covered (statements and branches); remove `packages/api/src/server.ts` from the exclusion list only if the entry is now small enough that its spawned tests cover it. They cannot be measured (child process), so it **stays excluded** and the file's size (about 40 lines) is the reason in the comment.

- [ ] **Step 3: Mutation, packaging, e2e.** `npm run mutate` on `config.ts`, `tls-runtime.ts` and `runtime.ts` (copy of the repo, `--bail=1`); the packaging suite in the Debian container (`packaging/test/run.sh service install migrate-tls tls`); `npm run test:e2e`.

- [ ] **Step 4: Docs.** `docs/architecture.md`: one sentence for `config.ts`/`runtime.ts`/`server.ts`. `CLAUDE.md`: a line in the working conventions: "Startup is `loadConfig` (pure) then `startServer` (the wiring); `server.ts` is only the entry. A new setting is read in `config.ts`; a new part that starts or stops goes in `runtime.ts`'s start and `stopParts` together." Update the spec's open question 1 to the decision made here.

- [ ] **Step 5: Full gates and the PR.** `npx prettier --write packages docs CLAUDE.md`, `npm run lint`, `npm test`; then `git push -u origin api-config-runtime` and `gh pr create` (no release label) with the removed-lines output, the table of gates, and the three notes from Task 8 (host root, version/node arguments, retention early check yes/no).

- [ ] **Step 6: Pi check (the person runs it).** After release, on `Io`: `sudo systemctl restart pipulse` and `sudo journalctl -u pipulse -n 20` show the same listening line as before; `curl -s https://io.local:8889/api/health` is `ok`; a deliberately bad `PIPULSE_ALLOWED_HOSTS` in `/etc/pipulse/pipulse.env` gives one `[pipulse] …` line and the service stays stopped (then remove it). Capture both outputs before cleaning up.

---

## Self-review (done against the spec)

- **Spec coverage:** goal 1 (`loadConfig`) Task 8; goal 2 (`startServer`) Task 10; goal 3 (thin entry) Task 11; goal 4 (routes) Tasks 3-7; "files after the change" Tasks 2-11; "behaviour that must not change" Tasks 1, 7, 11, 12 (surface test, removed-lines check, spawned tests, three-outputs test); tests list Tasks 8-10; two PRs; risks: ordering Task 10 (order list and the `INITIAL_SIGNATURE` note), top-level `await` Task 10 (`startServer` is async), changed message Task 8 Step 1 (oracle table), coverage Tasks 8-12.
- **Placeholders:** the move tasks name exact base-commit line ranges and show every edit; Tasks 8-10 give the test cases and the code for `config.ts` in full and an exact edit table for `tls-runtime.ts` and `runtime.ts` (their bodies are moved code, copied by `sed`, not retyped). The `REFUSALS` rows and the Task 9 test bodies are written from captured output / the named fixtures during the task and must not be committed as comments.
- **Type consistency:** `PiPulseConfig` fields are the names used in Tasks 9-11 (`config.tls`, `config.env`, `config.allowedHosts`, `config.runtimeDir`, `config.warnings`, `config.hostRoot`, `config.alertsFile`, `config.notifyFile`, `config.inContainer`, `config.hstsSeconds`, `config.version`, `config.node`, `config.webDir`, `config.dbPath`, `config.host`, `config.port`, `config.auth`, `config.allowedOrigins`); `StartupError`/`refuse` come from `config.ts`; `StartOverrides`/`RunningServer` from `runtime.ts`; `registerMetricsRoutes`, `registerHealthRoutes`, `registerLiveRoutes`, `registerDashboard`, `LiveDeps` are named identically where defined and used.
- **Review Focus:** items 1-5 map to Tasks 8/10 (1), 10 (2), 9 (3), 10 (4), 11 (5).
