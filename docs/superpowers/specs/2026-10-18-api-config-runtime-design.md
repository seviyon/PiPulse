# API startup: config, runtime and a thin entry

Status: design for review, 2026-10-18. A pure refactor of `packages/api`: no behaviour change except that every environment check now happens before the database is opened. Two PRs, each leaving `main` releasable.

## Why

`packages/api/src/server.ts` is 580 lines that run when the file is imported. About 25 `process.env` reads, the TLS checks, opening the database and all the wiring (collector, housekeeping, alerts, notifications, certificate reloader, listen, shutdown) are top-level statements, and `fail()` calls `process.exit(1)` from the middle of them. Three consequences:

- **It can only be tested by spawning the built file.** `test/server.test.ts` does that for 12 cases, which is slow and which Vitest cannot measure: `server.ts` is on the coverage exclusion list (`vitest.config.ts`), so the most important wiring in the app is invisible to the coverage gate.
- **Config errors can arrive after side effects.** `PIPULSE_ALLOWED_HOSTS` is validated near the end of the file, after the database is open and webhook delivery has started; `PIPULSE_RETENTION_*` after the database is open. A refusal should come before anything has been done.
- **`packages/api/src/index.ts` does two jobs.** It is the package's exports and the app factory `buildServer()` (470 lines), and the health, config, metrics, history and live routes are still inline in it, while alerts, auth, notify, settings and updates already have route files.

Measured on the Pi and in review (2026-10-18): none of this is broken. It is the part of the code that is hardest to change safely, and it sits in front of every start.

## Goal

1. All settings are read and validated in one place, `loadConfig(env)`, which throws a one-line error and does nothing else.
2. The wiring is a function, `startServer(config)`, that returns a handle and never exits the process, so it runs in a test.
3. `server.ts` is the thin entry (load, start, signals, exit codes).
4. `buildServer()` keeps its name and options, and its remaining inline routes move to route files like the others.

## Non-goals

- No change to any environment variable, message, exit code, log line, route, response or header.
- No change to `dist/server.js` (the systemd `ExecStart`, the installer and the Docker image run it), `package.json`'s `main`, or the exported names of the package.
- Existing route files stay where they are (no `routes/` folder: the imports in `server.ts`, `app.ts`, two test files and the docs would change for no gain).
- `packages/tls`, `collector`, `alerts`, `notify` and `storage` are not touched.
- No classes or dependency-injection framework: functions and plain objects, as elsewhere in the repo.

## Design

### Files after the change

```text
packages/api/src/
  index.ts          barrel: the package's exports only (as in the other packages)
  app.ts            buildServer(): create Fastify, response and host hooks, register the route modules
  options.ts        ServerOptions, PluginInfo, DeviceInfo (types moved out of index.ts)
  feed.ts           Feed, createFeed, createLiveFeed
  health-routes.ts  /health, /api/health, /api/config
  metrics-routes.ts /api/metrics/latest, /:id/history, /:id/series (with the raw cap)
  live-routes.ts    /api/live (WebSocket) and the static dashboard
  config.ts         loadConfig(env): PiPulseConfig, validated, no side effects
  tls-runtime.ts    certificate load at start, reloader, tls-status.json, the data-folder marker
  runtime.ts        startServer(config): the wiring; returns { app, stop() }
  server.ts         the entry: ~30 lines
  (unchanged)       alert-routes, auth-routes, auth, container, hash-password, health, host,
                    notify-routes, notify-test, origin, plain-http, settings-routes, tls-status,
                    updates, updates-routes, version
```

`index.ts` keeps re-exporting every name it exports today (`buildServer`, `createFeed`, `createLiveFeed`, `longestLookBack`, `rawRetentionProblem`, the option and feed types), so the 18 test files that import `../src/index.js` do not change.

### `config.ts`

```ts
export interface PiPulseConfig {
  dbPath: string;
  host: string;
  port: number;
  webDir: string;
  allowedOrigins: string[];
  allowedHosts: string[]; // parsed, with the host's own names added
  inContainer: boolean;
  hostRoot?: string;
  auth: AuthConfig; // readAuthConfig(env): already pure
  tls: TlsConfig; // readTlsConfig(env, { releaseDefault })
  hstsSeconds?: number;
  runtimeDir: string;
  alertsFile?: string; // paths only: the files are read in startServer
  notifyFile?: string;
  env: NodeJS.ProcessEnv; // for the retention source, which needs the database
}
export function loadConfig(env: NodeJS.ProcessEnv): PiPulseConfig;
```

- It throws an `Error` whose message is the one line the process prints today, with the same variable names. Nothing in it opens a file for writing, a database or a socket. The files `readAuthConfig` and `readTlsConfig` already read stay as they are.
- `PIPULSE_RETENTION_*` is validated here too, with storage's own parser (`retentionFromEnv`), so a bad value is refused before the database is opened. The plan confirms the message is identical to today's; if it is not, the database-side check stays and this one is left out.
- The certificate itself (reading and classifying the PEM files) is not config: it is a check of material, and stays in `tls-runtime.ts`, still before the database is opened.

### `tls-runtime.ts`

The part of `server.ts` that is only about the certificate: load at start (the `SEVERE` line for an expired one, the refusals), the `publishRuntime()` status file, the data-folder marker, and starting the reloader once `app.server` exists. It exports small functions (`loadServingCertificate(config)`, `startCertificateReloader(...)`, `publishRuntimeStatus(...)`), each testable on its own with the fixtures that `packages/tls` already ships.

### `runtime.ts`

```ts
export interface RunningServer {
  app: FastifyInstance;
  address(): { host: string; port: number };
  /** Stops everything in the order below; `drained` is false when sensor reads were still running. */
  stop(): Promise<{ drained: boolean }>;
}
export async function startServer(config: PiPulseConfig): Promise<RunningServer>;
```

The order is the order today, with the config checks already done:

1. Certificate loaded and checked (refusal stops here; nothing has been opened).
2. Database opened; retention source resolved; rules and webhooks files read; raw retention checked against the longest look-back (each refusal is an `Error` with today's message).
3. Notifications started, health created, feeds created.
4. `buildServer(db, options)`; the certificate reloader started (it needs `app.server`).
5. Housekeeping, collector scheduler, alert engine started.
6. `app.listen`; then the post-listen log lines, the data-folder marker and `updates.start()`.

Two late-bound holders stay exactly as they are today, because their order cannot change: the engine (`buildServer`'s `recheck` hook needs an engine that starts after it) and the TLS provider (its `apply` needs `app.server`).

`stop()` keeps today's shutdown order: reloader, housekeeping, alert engine, updates; then `app.close()`, `scheduler.stop(5000)` and `notifications.stop()` together; then `db.close()`. It returns `{ drained }`; it does not exit.

### `server.ts`

```ts
let config: PiPulseConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  fail(error);
}
const running = await startServer(config).catch(fail);
// SIGINT/SIGTERM: stop(); exit 1 when not drained; a second signal exits 1 at once
```

`fail()` (print `[pipulse] <message>`, exit 1) lives only here. A throw anywhere in `startServer` reaches it, so the refusals keep their message and exit code.

### The routes that move

The bodies move unchanged into `health-routes.ts`, `metrics-routes.ts` and `live-routes.ts`, each exporting `registerX(app, db, options, ...)` the way `registerAuth` and the alert routes already do. The global hooks (security headers, HSTS, host allowlist, the plain-HTTP hint) stay in `app.ts`, in their current order: the order of `onRequest` and `onSend` hooks is behaviour.

## Behaviour that must not change

| What                                                                             | Pinned by                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Refusal messages, variable names and exit code 1                                 | the 12 spawned-process tests in `server.test.ts`, kept as they are     |
| `dist/server.js` is the entry, `main` is unchanged                               | the existing `server.test.ts`, the packaging suite and the e2e harness |
| Hook order and every header (CSP, frame, `no-store`, HSTS, 421, plain-HTTP page) | `security-headers.test.ts`, `host.test.ts`, `plain-http-hint.test.ts`  |
| Shutdown order and the 5 s drain                                                 | a new in-process test with fake timers on `stop()`                     |
| Startup order: nothing opened before the config and the certificate are valid    | new tests (below)                                                      |

## Tests

New, in `packages/api` (coverage is per package):

- `config.test.ts`: every setting valid, invalid (the exact message) and unset; empty `PIPULSE_PORT` is 8889; `PIPULSE_ALLOWED_HOSTS` with and without `auto`; `loadConfig` leaves no file, socket or database behind (run in an empty temp directory).
- `runtime.test.ts`: `startServer` on port 0 over HTTP and over HTTPS (the TLS fixtures), serves `/health`, `stop()` resolves `{ drained: true }`; an invalid certificate rejects before a database file exists; a bad rules file rejects with its message; `stop()` returns `drained: false` for a hung read (fake timers); a second `stop()` is harmless.
- `tls-runtime.test.ts`: the expired-certificate `SEVERE` line, the data-folder marker written and refused, the runtime status file.
- The route moves need no new tests: the existing route tests exercise them through `buildServer`.

Before each PR is pushed: the changed lines covered by `packages/api`'s own run, a mutation run on `config.ts`, `runtime.ts` and `tls-runtime.ts` (`npm run mutate`), the packaging suite and the e2e suite (both start the real built server), and `npm test`, lint and Prettier.

## Plan: two PRs

1. **Routes and barrel.** `options.ts`, `feed.ts`, `health-routes.ts`, `metrics-routes.ts`, `live-routes.ts`, `app.ts`; `index.ts` becomes the barrel. No test changes beyond imports that moved. Behaviour identical by construction: bodies are moved, not rewritten.
2. **Config and runtime.** `config.ts`, `tls-runtime.ts`, `runtime.ts`, the thin `server.ts` and the new tests. This is where the review effort goes.

Neither carries a release label: nothing a user can see changes. (The one visible difference, a bad `PIPULSE_ALLOWED_HOSTS` or `PIPULSE_RETENTION_*` being refused before the database is opened rather than after, produces the same message and exit code.)

## Risks

- **Ordering.** The wiring has real dependencies (the engine, the reloader). Keeping the late-bound holders as they are, and the order above, is the mitigation; the in-process tests and the spawned-process tests both cover it.
- **Top-level `await`.** `readDeviceInfo` is awaited at module level today; it moves into `startServer`, which is already `async`.
- **A changed message.** `loadConfig` moves checks, so a message could change by accident. The spawned tests assert the current messages; the plan adds a table of every refusal line, taken from the running code, as the oracle.
- **Coverage.** `runtime.ts` and `tls-runtime.ts` are not on the exclusion list, so they must be covered by `packages/api`'s own tests. That is the point, but it is the work.

## Open questions (1 and 2 settled by the plan, see `docs/superpowers/plans/2026-10-18-api-config-runtime.md`)

1. **Decided in the plan: a small `StartupError` class**, not plain `Error`. Today three failures end the process differently (a refusal prints `[pipulse] <message>`, a `listen` failure such as `EADDRINUSE` prints the whole error, anything else crashes with Node's own output), and the entry can only keep them apart if refusals are marked.
2. **Decided in the plan: yes.** `retentionFromEnv` and the runtime's `resolveRetention` apply the same rule and print identical messages (checked on the base commit), so `loadConfig` validates `PIPULSE_RETENTION_*` early.
3. `package.json`'s `main` is `dist/server.js`, so importing the package starts it. Left alone, since the installer and unit rely on the path, not on `main`; worth a separate look later.
