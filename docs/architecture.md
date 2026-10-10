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
- **API**: a Fastify server exposes REST endpoints for current values, historical queries, and config, plus a WebSocket channel that pushes new samples as they arrive. See [API](api.md).
- **Web**: a browser dashboard consuming the API/WebSocket: a live status view, historical charts, an alerts view, and Settings.
- **Alerting**: a rules engine evaluates the same KPI values with hysteresis (a condition must last `for` a while to raise and be normal for `clearAfter` to clear) and shows open alerts on the dashboard. See [Alerts and notifications](alerts.md).
- **Notifications**: raised and cleared alerts are queued in the database and delivered to webhooks in order, with retries.
- **TLS**: a fresh install serves HTTPS from a name-constrained CA made for that Pi; the CA key is never readable by the server. See [HTTPS](https.md).

The reasoning behind each decision is in [PLAN.md](PLAN.md).
