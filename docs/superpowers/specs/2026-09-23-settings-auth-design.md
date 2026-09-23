# Phase 5b-1 — Authentication, settings and the retention editor: design

Status: approved in brainstorming on 2026-09-23; this document is for review before the implementation plan.

Phase 5b in `docs/PLAN.md` is split into separate pieces, each with its own spec, plan and PR:

- **5b-1 — Authentication, settings and the retention editor (this document).** Everything later writes through it, and it carries the exit criterion `docs/PLAN.md` gives Phase 5b.
- **5b-2 — Rules in the browser.** Adding, editing and disabling alert rules, stored in the database above the file and the built-ins; acknowledging alerts; revisiting `swap_heavy`, which stays open permanently on the Pi 2 (swap sits at a flat 81 % in a small swap file).
- **5b-3 — Notifications.** A webhook (e.g. to Apprise) on the alert engine's `onChange` seam.

## Goal

One operator can change PiPulse's data retention from the browser, safely, and nobody else on the LAN can change anything:

- Every write needs a signed-in session; reads can optionally need one too.
- A retention change applies within a minute, without a restart, and survives one.
- A change that deletes data says how much before it happens and needs explicit confirmation.
- The page helps choose a policy for the storage at hand: a small SD card on the Pi 2 today, a large NVMe drive on a Pi 5 later.

**Success:** see [Exit criterion](#exit-criterion).

## Context and assumptions

- One operator, one Pi, reached directly over the LAN (no reverse proxy). ufw limits the port to 192.168.1.0/24. A TLS reverse proxy may front PiPulse later; support for it (trusting `X-Forwarded-*`) is deferred until one exists, since trusting those headers without a proxy lets any client spoof them.
- PiPulse speaks plain HTTP, so the password crosses the LAN once at sign-in and the session cookie with every request. Accepted for a single-user LAN; TLS through a proxy is a later option.
- One login, no user accounts or roles.

## Scope

In scope: password hash file and a `hash-password` command; sign-in, sign-out and sessions; one enforcement hook for every `/api` route and the WebSocket, with optional read protection; the `settings` table (migration 5); retention resolved from environment, saved value and default, applied live; `GET/PUT /api/settings` and `POST /api/settings/preview`; automatic `VACUUM` after large deletions; a Settings page and a sign-in form.

Out of scope for 5b-1:

- Rule editing, acknowledging alerts and `swap_heavy` (5b-2); notifications (5b-3).
- Several users or roles.
- Changing the password from the UI: replace the hash file and restart.
- Sessions that survive a server restart.
- Reverse-proxy support (`X-Forwarded-Proto` / `X-Forwarded-For`), until a proxy exists: planned as `PIPULSE_TRUST_PROXY`, see "Future: behind a reverse proxy" in `docs/PLAN.md`.

## Authentication

### Password

- `PIPULSE_ADMIN_PASSWORD_HASH_FILE` names a file holding one line: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>` (scrypt from `node:crypto`; no new dependency). Defaults for new hashes: N = 2^15, r = 8, p = 1, 16-byte salt, 32-byte hash.
- The plain password is never stored. `node packages/api/dist/hash-password.js` asks for it twice without echoing, refuses an empty or mismatched entry, and prints the line.
- The file should be readable only by the service user (`0600`). The same `_FILE` path works as a systemd `LoadCredential=` path (keeps it out of the environment; systemd 247 on Bullseye supports it) or a Docker secret.
- An unreadable or malformed file stops startup with one line naming the variable and the path, like a broken `PIPULSE_ALERTS_FILE`.
- **Read-only mode:** with the variable unset, PiPulse runs as today. Every write answers `403` (`editing is disabled: no admin password configured`) and the Settings page explains how to enable editing. Nothing is ever writable without a password, and an upgrade from 5a keeps working unchanged.

### Sessions

- `POST /api/login {password}` verifies with a constant-time comparison. On success it creates a session and sets `pipulse_session`: a random 256-bit id (base64url), `HttpOnly`, `SameSite=Strict`, `Path=/`, plus `Secure` when the connection itself is HTTPS.
- Sessions live in server memory: a map from id to last use. They expire after 7 days without use; each authenticated request refreshes the timestamp. A restart signs everyone out, and no signing key has to exist anywhere.
- `POST /api/logout` ends the session and clears the cookie.
- `GET /api/session` → `{ editable, signedIn, protectReads }`, always public, so the UI knows what to show.
- **Rate limit:** 5 failed sign-ins per client IP (the connection's address) per 15 minutes, then `429` until the window passes. Every failure waits about 1 s before answering. The response to a failure never says why it failed and never echoes the password.

### Enforcement

One Fastify `onRequest` hook decides every request; routes do not check auth themselves.

| Request                               | Read protection off                          | Read protection on                    |
| ------------------------------------- | -------------------------------------------- | ------------------------------------- |
| Static dashboard files                | public                                       | public (they hold no data)            |
| `GET /api/session`, `POST /api/login` | public                                       | public                                |
| Other `/api` `GET`                    | public                                       | session, else `401`                   |
| `/api/live` WebSocket                 | public                                       | session, else closed with code `4401` |
| Any other `/api` method               | session, else `401`; `403` in read-only mode | same                                  |

- `PIPULSE_PROTECT_READS=true|false` (default `false`); any other value stops startup.
- **CSRF:** besides `SameSite=Strict`, a write carrying an `Origin` header must match the server's host or `PIPULSE_ALLOWED_ORIGINS` (the check `/api/live` already uses), else `403`. A write without `Origin` (e.g. `curl`) is allowed; it still needs the session cookie.
- **Ports and adapters:** the password, session and rate-limit logic is plain TypeScript in `packages/api/src/auth.ts` with an injected clock, and knows nothing of Fastify. Only the hook and the routes touch Fastify.

## Settings storage

- **Migration 5:** `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`, values stored as JSON. Key/value so 5b-2 and 5b-3 can add keys without another migration.
- 5b-1 keys: `retention.raw`, `retention.1m`, `retention.1h`, `retention.1d`, each holding the duration text as typed (`"30d"`, `"forever"`), so the page shows it back unchanged.
- `packages/storage` exposes `getSettings(db)` / `saveSettings(db, values, now)`; saving writes every key in one transaction.

## Retention: resolution and live apply

- `resolveRetention(env, saved)` returns, per level, `{ ms, text, source: 'env' | 'saved' | 'default', variable? }`. The environment variable wins, then the saved value, then the built-in default, using the existing `parseDuration`, so the UI and the environment accept exactly the same text (`30s`, `5min`, `36h`, `14d`, `2w`, `1y`, `forever`; no bare `m`).
  - A bad environment value stops startup, as today.
  - A saved value that no longer parses (e.g. after a future grammar change) is logged once and skipped, falling back to the default rather than stopping the server.
- **Live apply:** `getRetention()` replaces the fixed `RETENTION` constant in `packages/api/src/server.ts` and `packages/collector/src/main.ts`. Housekeeping calls it at the start of every run, and `/series` (`chooseResolution`) calls it per request. A saved change therefore applies within a minute, survives restarts, and is seen by the standalone collector daemon too, with no signalling between components.
- **Validation** (used by preview, save, and startup for environment values):
  - Each level is a valid duration; raw ≤ 1m ≤ 1h ≤ 1d, because housekeeping needs each level to cover the one below.
  - Raw retention is at least the longest `for`/`clearAfter` of the alert rules in force, since alerts read raw readings. The error names the rule: `raw retention must be at least 15min: rule "load_queueing" looks back 15min`.
  - A field set by an environment variable cannot be changed through the API (`400`, naming the variable).

## Automatic compaction

SQLite reuses freed pages but does not shrink the file, so after a retention cut `du` shows the old size until the database is compacted.

- After a housekeeping run, if free pages (`PRAGMA freelist_count`) are at least 25 % of the file **and** the file is over 8 MB, PiPulse runs `VACUUM`.
- First it checks free disk space (`fs.statfs` on the database's directory) is at least 2.1 × the file size: VACUUM builds a temporary copy and, in WAL mode, writes the rebuilt database through the log, so the peak is about twice the file. Otherwise it logs one line and skips.
- At most once a day, so repeated changes cannot rewrite the card repeatedly.
- Logs `vacuum: 42.1 MB → 12.3 MB in 1.8 s`. A failure is logged and housekeeping carries on.
- On the Pi 2's SD card this is a few seconds with writes paused; on NVMe it is well under a second.

## API

All routes go through the enforcement hook.

- `GET /api/settings` →
  - `retention`: per level `{ text, ms, source, variable?, locked }`.
  - `storage`: `{ fileBytes, freeBytes (free pages), diskFreeBytes, levels: { raw|1m|1h|1d: { rows, oldest } } }`.
- `POST /api/settings/preview { retention }` → validation errors (`400`, as for save), or per level `{ deletesRows, from, to }` for data the next housekeeping run would remove, plus `estimatedBytes` for the policy once full. Changes nothing.
- `PUT /api/settings { retention, confirmDeletion? }` → same validation; if the change deletes any rows and `confirmDeletion` isn't `true`, `409` with the preview. On success, returns the new `GET` body.
- **Size estimate:** rows per day per level from what is actually collected: raw = Σ over plugins of 86 400 s / interval; 1m = metrics × 1440; 1h = metrics × 24; 1d = metrics. Bytes per row = used pages × page size ÷ total rows in the current database. Levels kept forever are estimated for one year and labelled so. The UI rounds and labels the result as an estimate (`≈ 240 MB`).
- **Scale, for reference** (Phase 4's seeded database, ~50 bytes per row, 12 metrics):

  | Level | Default | Rows per day | Size at default  |
  | ----- | ------- | ------------ | ---------------- |
  | raw   | 2d      | ~190 000     | ~19 MB           |
  | 1m    | 14d     | ~17 000      | ~12 MB           |
  | 1h    | 1y      | ~290         | ~5 MB            |
  | 1d    | forever | 12           | ~0.2 MB per year |

  Raw retention dominates: 90 days of raw is ~850 MB, fine on a Pi 5's NVMe but not on the Pi 2's nearly full 16 GB SD card, which is why the estimate is shown before saving.

## Dashboard

A Settings link in the nav, page `#/settings`.

- **Read-only mode:** current values with their sources, storage figures, and a short box explaining how to enable editing (the hash command and the variable).
- **Editable, signed out:** a password field and a Sign in button.
- **Signed in:** a "Sign out" link in the header, and per level an input with its source beside it (`default`, `saved`, or 🔒 `set by PIPULSE_RETENTION_RAW`, disabled).
  - Values are checked as typed; the server's preview is the authority and reports errors per field.
  - **Review changes** shows the preview: levels that get shorter in the critical style with words (`Deletes ~41 000 raw readings from Sep 21 18:00 to Sep 22 18:00 within a minute`), longer ones as a note (`Already-deleted data doesn't come back; keeps more from now on`), and the estimated size.
  - When anything would be deleted, **Save** stays disabled until "I understand this deletes data" is ticked.
  - After saving, a confirmation line and refreshed figures.
- **Read protection on, signed out:** the whole app shows only the sign-in form (no nav, no data) and continues to the requested page after signing in. A `401` from any fetch or a WebSocket close with `4401` (e.g. an expired session) returns to it.
- Status is never colour alone (icon and words), as elsewhere.

## Errors

| Situation                                                                               | Result                                          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Hash file unreadable or malformed; bad `PIPULSE_PROTECT_READS` or `PIPULSE_RETENTION_*` | Startup stops with one line naming the variable |
| Not signed in                                                                           | `401` (WebSocket: close `4401`)                 |
| Editing disabled (no password) or foreign `Origin`                                      | `403`                                           |
| Invalid value, or a field locked by the environment                                     | `400` naming the field and the reason           |
| Deletion not confirmed                                                                  | `409` with the preview                          |
| Too many sign-in attempts                                                               | `429`                                           |
| Saved value no longer parses                                                            | Logged once; default used                       |
| `VACUUM` skipped or failed                                                              | Logged; housekeeping continues                  |

## Testing

Vitest, in CI like every phase:

- **auth:** hash file parsing and verification; constant-time comparison; expiry and refresh on a fake clock; the rate limit and delay on fake timers; `Secure` only over HTTPS or a trusted proxy; `hash-password`'s output verifies.
- **hook:** a table of every route × {read-only, signed out, signed in} × {read protection off, on} against the expected status; the WebSocket closing with `4401`; a foreign `Origin` rejected.
- **settings:** environment › saved › default with the source reported; an invalid saved value falling back; the order between levels; raw retention shorter than a rule's window rejected; preview counts and spans on a seeded database; `409` without confirmation; housekeeping picking up a change on its next run with no restart; the change surviving a reopened database.
- **vacuum:** thresholds, the free-space check and once-a-day limit, with a fake clock and a fake `statfs`.
- **web** (happy-dom): each page state (read-only, signed out, editable, locked field); the deletion checkbox enabling Save; a `401` bringing up the sign-in form.

## Exit criterion

On the Pi 2 (Node 22 via nvm, port 8889, a copy of a real database):

1. With no hash file, the Settings page is read-only and `curl -X PUT /api/settings` answers `403`.
2. With a hash file, an unauthenticated `PUT` answers `401`.
3. Signed in, shortening raw retention shows the deletion preview, needs the checkbox, and within a minute the old raw rows are gone.
4. The saved value survives a server restart.
5. A large deletion triggers the logged `VACUUM` and the file shrinks.
6. With `PIPULSE_PROTECT_READS=true`, a signed-out browser sees only the sign-in form and `curl /api/metrics/latest` answers `401`.
7. Tests pass in CI.

## Security

- Writes always need a session; reads optionally. Sessions are unguessable (256 bits), `HttpOnly` (no script access), `SameSite=Strict` plus an `Origin` check (CSRF), and `Secure` behind TLS.
- The password is stored only as an scrypt hash in a file the operator controls; a leaked hash still has to be brute-forced, slowly.
- Sign-in is rate-limited per IP. Error bodies never reveal why sign-in failed.
- Every settings query uses bound parameters.
- Remaining risk: without TLS, someone sniffing the LAN can capture the password at sign-in or a session cookie. Accepted for a single-user LAN behind ufw's LAN-only rule; TLS through a proxy is a later option.
