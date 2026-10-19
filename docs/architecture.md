# Architecture

```
PiPulse/
  packages/
    storage/     # SQLite schema, migrations, rollups, retention
    collector/   # metric plugins + scheduler
    alerts/      # alert rules, raise/clear decisions, 15 s engine
    notify/      # webhook notifications: outbox, sender, templates
    tls/         # certificates: the per-Pi CA, renewal, the `pipulse tls` CLI
    api/         # Fastify HTTP + WebSocket server (runs the collector and engines)
    web/         # Preact dashboard (built with Vite)
  packaging/     # install.sh, .deb and tarball builds, systemd units, packaging tests
  e2e/           # Playwright end-to-end tests (standalone, not a workspace)
  compose.yaml   # Docker: server, CA sidecar and init
  docs/          # these pages, the plan, and the specs/plans behind each phase
```

Packages build in dependency order: storage, collector, alerts, notify, tls, api, web.

- **Collector**: small TypeScript plugins poll system metrics (via [`systeminformation`](https://systeminformation.io/) plus Pi-specific commands like `vcgencmd`) on their own interval and write samples to storage.
- **Storage**: SQLite (WAL mode). Raw samples are periodically downsampled into 1-minute/1-hour/1-day rollups and pruned, keeping the database size bounded the way RRD's fixed-size files did, but with configurable retention instead of a format baked in at file-creation time.
- **API**: a Fastify server exposes REST endpoints for current values, historical queries, and config, plus a WebSocket channel that pushes new samples as they arrive. See [API](api.md). `app.ts` builds the Fastify app and registers the route modules (`health-routes`, `metrics-routes`, `alert-routes`, `notify-routes`, `updates-routes`, `settings-routes`, `live-routes`); `index.ts` is only the package's exports. Startup is three files: `config.ts` (`loadConfig` reads and validates every setting and has no side effects; a bad one is a `StartupError`), `runtime.ts` (`startServer` does the wiring and returns a handle with `stop()`; the certificate parts are in `tls-runtime.ts`), and `server.ts`, the entry, which only decides what the process prints and which code it exits with.
- **Web**: a browser dashboard consuming the API/WebSocket: a live status view, historical charts, an alerts view, and Settings.
- **Alerting**: a rules engine evaluates the same KPI values with hysteresis (a condition must last `for` a while to raise and be normal for `clearAfter` to clear) and shows open alerts on the dashboard. See [Alerts and notifications](alerts.md).
- **Dashboard layout**: `packages/web/src` has the shell at the top (`main.tsx`, `app.tsx`, `router.ts`, `sign-in.tsx`, `build.ts`, `styles.css`) and one folder per area: `core/` (API client, live store, formatting, types), `now/` (tiles, sparklines, status), `history/`, `alerts/` (page and rules editor), `settings/` (page, certificate, notifications, about) and `updates/`. A test sits in the same folder under `packages/web/test`.
- **TLS package layout**: `packages/tls/src` has `common/` (files, process, host name, env file, PEM), `settings/` (config, clock), `inspect/` (judging an existing certificate, the reloader, replacement rules), `ca/` (the generated CA and leaf: issuance, constraints, layout, material, journal, lock, clock anchor, runtime status) and `cli/` (the `pipulse tls` commands and the Docker sidecar). `index.ts`, `cli.ts` and `health-check.ts` stay at the top because the installer, `setup.sh`, the `pipulse` command and the Docker health check run `dist/cli.js` and `dist/health-check.js` by path. Imports only go down that list (`common` first, `cli` last); `test/module-layering.test.ts` enforces it. Tests sit in the folder of the module they cover; `test/helpers.ts`, `test/openssl.ts` and `test/fixtures/` stay at the top (the api tests and the e2e harness use them).
- **Notifications**: raised and cleared alerts are queued in the database and delivered to webhooks in order, with retries.
- **Updates**: the server asks apt, as its own unprivileged user, what `apt-get upgrade` would do (a simulation, 2 minutes after start and every 6 hours) and shows it on the Updates tab with the exact commands to run. It never installs anything, and does nothing in Docker. See [API](api.md).
- **Request guards**: one hook decides sign-in for every request, an optional Host allowlist (`PIPULSE_ALLOWED_HOSTS`) answers `421` to unknown names, and every response carries a Content-Security-Policy and frame protection.
- **Dashboard build check**: the web bundle knows the release it was built as and warns when the server it talks to is a different version.
- **TLS**: a fresh install serves HTTPS from a name-constrained CA made for that Pi; the CA key is never readable by the server. See [HTTPS](https.md).

The reasoning behind each decision is in [PLAN.md](PLAN.md).
