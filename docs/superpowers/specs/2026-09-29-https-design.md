# Phase 6b — HTTPS by default: design

Status: approved in brainstorming on 2026-09-29 (seven sections, each reviewed and revised); this document is for review before the implementation plan.

Today PiPulse speaks plain HTTP: anyone who can watch the LAN (shared Wi-Fi, a guest VLAN) can read the sign-in password and the session cookie. This phase makes every fresh install serve HTTPS with no manual certificate work, lets operators bring their own certificate, and moves existing HTTP installs over only when the operator says so.

## Goal

- **HTTPS by default** on fresh installs, from a per-install certificate authority (CA) whose fingerprint the operator verifies out of band and trusts once; its leaf certificate renews itself.
- **Operator certificates** (`PIPULSE_TLS_CERT` + `PIPULSE_TLS_KEY`) as an alternative source.
- **An explicit HTTP opt-out** (`PIPULSE_TLS=off`) with loud warnings, stronger when sign-in is on.
- **Existing HTTP installs keep working** after upgrading, with HTTPS prepared and one command (`sudo pipulse tls enable`) to switch, and one to switch back.

**Guiding rule:** a certificate problem degrades the web interface, never monitoring. Collection, alert checks and notification delivery keep running whatever state the certificate is in.

**Success:** see [Exit criteria](#exit-criteria).

## Scope and delivery

One spec, two PRs:

- **6b-1 — TLS core** (release `v0.6.3`, `release:patch`; the default stays HTTP): mode resolution, `packages/tls` inspection/files/reload, the server's HTTPS listener, live reload, certificate state in health/config/Settings/logs, `Secure` cookies, opt-in HSTS, and TLS-aware clients (installer, Docker healthcheck). Operator certificates only.
- **6b-2 — generated trust** (release `v0.7.0`, `release:minor`): name constraints, issuance, the `pipulse tls` CLI, `state.json` and the migration of existing installs, the renewal timer, the Docker sidecar and compose hardening, certificate expiry alerts, the interactive/unattended installer split, HTTPS as the fresh-install default, and the docs.

Out of scope:

- A plain-HTTP listener that redirects to HTTPS, and HTTP/TLS multiplexing on one port. HTTPS stays on **8889**; an old `http://` bookmark fails (Node closes the socket, the browser shows an empty response). The installer, `docker compose logs` and the README give the new URL. A redirect listener can be added later if anyone asks.
- Trusting `X-Forwarded-*` (`PIPULSE_TRUST_PROXY` stays out; see "Future: behind a reverse proxy" in `docs/PLAN.md`).
- ACME / public certificates issued by PiPulse. An operator who has one uses the operator source.
- HSTS by default (see [HSTS](#hsts)).

## Decisions

| Topic             | Decision                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Old `http://` URL | HTTPS only on the same port; no redirect listener                                                                  |
| Trust model       | Per-install CA (10 years) + generated leaf (90 days); CA fingerprint is the durable trust identity                 |
| Name constraints  | Critical `nameConstraints` on the CA; names-only by default; one IPv4/IPv6 subnet only by explicit operator choice |
| Existing installs | Stay HTTP until `sudo pipulse tls enable`; HTTPS material prepared on upgrade                                      |
| CA key            | Never readable by the long-running server, native or Docker                                                        |
| Renewal           | Root systemd timer (native), sidecar loop (Docker); server reloads in-process                                      |
| Tooling           | `openssl` CLI via `execFile` for issuance; Node's `crypto.X509Certificate` for inspection                          |
| Keys              | ECDSA P-256                                                                                                        |
| HSTS              | Off by default; opt-in                                                                                             |

## Mode resolution

The mode is `https` or `http`, resolved once at startup:

1. `PIPULSE_TLS=on|off` in the environment (process environment, `Environment=`, `pipulse.env` — anything the operator controls). Any other value refuses startup.
2. Otherwise `state.json`'s `mode` (`https` → HTTPS, `legacy-http` → HTTP).
3. Otherwise the release default: **6b-1: HTTP**. **6b-2: refuse to start** with one line: `set PIPULSE_TLS_CERT and PIPULSE_TLS_KEY, or PIPULSE_TLS=off` (covers plain `docker run` and bare dev runs; `npm run dev` sets `PIPULSE_TLS=off` explicitly).

`state.json` is data, never an `EnvironmentFile` and never sourced by a shell:

```json
{ "version": 1, "mode": "https" }
```

- Native: `/etc/pipulse/tls/state.json`; Docker: `/tls/state.json` (`PIPULSE_TLS_DIR`, default `/etc/pipulse/tls`).
- Strict parser: exactly these two keys, `version` `1`, `mode` `https` or `legacy-http`; unknown or duplicate keys refuse startup with a one-line fix; written atomically by setup, the CLI or the sidecar, never by the server.
- `enable` writes `https`, `disable` writes `legacy-http`; both are idempotent.

Test matrix (each row a test):

| Installation                 | `PIPULSE_TLS` | `state.json`  | Result           |
| ---------------------------- | ------------- | ------------- | ---------------- |
| 6b-1, any                    | unset         | —             | HTTP             |
| 6b-2 upgraded pre-6b         | unset         | `legacy-http` | HTTP             |
| 6b-2 upgraded pre-6b         | `on`          | `legacy-http` | HTTPS            |
| 6b-2 fresh                   | unset         | `https`       | HTTPS            |
| 6b-2 fresh                   | `off`         | `https`       | HTTP             |
| 6b-2 `docker run`, no `/tls` | unset         | absent        | refuse, fix line |
| 6b-2 compose (sidecar)       | unset         | `https`       | HTTPS            |

Changing the environment while the server runs has no effect until a restart.

## Certificate sources

- **Operator:** `PIPULSE_TLS_CERT` (leaf first, optional chain) and `PIPULSE_TLS_KEY`, always set together (one alone refuses startup). Optional `PIPULSE_TLS_CA` names the CA the health check and chain classification verify against (for a private CA); otherwise the system store. PiPulse never writes operator files and never renews them.
- **Generated:** `<tls dir>/leaf.pem` (key + chain, one file) and `<tls dir>/ca.crt`, made and renewed by `pipulse tls` (native) or the sidecar (Docker).

The source is fixed at startup; the reload poll watches only that source's files. Switching source (remove the two settings, `sudo pipulse tls init`, restart) is always an explicit operator action, so there is never a mixed state.

## `packages/tls`

No Fastify or SQLite types; no internal dependencies, so it builds any time before `api`. Build order becomes storage → collector → alerts → notify → tls → api → web.

| Module            | Role                                                                            | Used by                     |
| ----------------- | ------------------------------------------------------------------------------- | --------------------------- |
| `config.ts`       | Mode and source resolution; `state.json` parser                                 | server, CLI, sidecar        |
| `pem.ts`          | PEM block parsing for bundles and operator files                                | inspect, reload             |
| `inspect.ts`      | Separate facets: parse, key match, validity, clock, chain class, CA constraints | server, CLI, health check   |
| `files.ts`        | Safe reads and atomic writes                                                    | CLI, sidecar, reload        |
| `clock.ts`        | Clock state: `synced` / `unsynced` / `unknown`                                  | server, CLI, sidecar        |
| `constraints.ts`  | Name/subnet validation; candidate subnet and default-route detection            | CLI, sidecar                |
| `issue.ts`        | `openssl` config generation from canonical values; `execFile`                   | CLI, sidecar (root) only    |
| `journal.ts`      | CA transactions (`new-ca`, `restore-ca`)                                        | CLI, sidecar                |
| `reload.ts`       | The server's certificate provider                                               | server                      |
| `health-check.ts` | The one TLS client check                                                        | installer, Docker, `enable` |
| `cli.ts`          | `pipulse tls …` and `sidecar`                                                   | `/usr/bin/pipulse`, sidecar |

### PEM parsing

- Normalise CRLF to LF for parsing only; never compare or rewrite material using normalised text.
- Limits: 64 KiB per file, 8 blocks.
- Reject: an empty file; any label other than the allowed ones; duplicate private keys; any content after an invalid or non-PEM block; trailing non-PEM data.
- **`leaf.pem`** (generated only): exactly one PKCS#8 `PRIVATE KEY` and one or more `CERTIFICATE` blocks. PKCS#1/SEC1 labels and `ENCRYPTED PRIVATE KEY` are rejected.
- **Operator key file:** one unencrypted `PRIVATE KEY`, `EC PRIVATE KEY` or `RSA PRIVATE KEY` (each tested); `ENCRYPTED PRIVATE KEY` is rejected.
- The private key must match the **first** certificate. A bundle is not accepted because some later certificate matches the key.
- The result is `{ key, cert: <chain PEM> }` for `tls.createSecureContext`.

### Inspection facets

`inspect` returns separate facets, never one collapsed state:

- `parse`: ok / failed (which block).
- `keyMatch`: ok / mismatch (against the first certificate).
- `validity`: `valid` / `expiring-soon` (≤ 30 days generated, ≤ 14 days operator) / `expired` / `not-yet-valid`, computed against `now` and reported with the clock state.
- `clockSynced`: `synced` / `unsynced` / `unknown`.
- `chain`: the class below, plus reason codes.
- For generated material: CA fingerprint and constraints (from `ca-meta.json`).
- Leaf SANs, SHA-256 fingerprints of the leaf and CA, `notBefore`/`notAfter` (Unix ms).

### Chain classes

Ordered by how clients cope:

`valid` > `degraded-incomplete-chain` (a missing intermediate; browsers often fetch it) > `degraded-san` (a configured name missing from the SANs) > `degraded-untrusted` (the configured CA is absent, or the chain leads to an unexpected CA).

Refused outright (never degraded): unparseable member, key mismatch, a first certificate with `basicConstraints CA:TRUE`, a duplicate leaf, a bad signature or wrong issuer inside the supplied chain (each certificate must be `checkIssued` and signed by the next), an unrelated extra certificate. A chain in the wrong order is refused for the same reason: some certificate isn't issued and signed by the next. A malformed `PIPULSE_TLS_CA` anchor is refused too.

Refusal lines name the setting: chain and key refusals are prefixed `PIPULSE_TLS_CERT/PIPULSE_TLS_KEY: …` (a generated source names its bundle file instead), and a CA anchor that can't be parsed says `PIPULSE_TLS_CA: certificate N can't be parsed`. `PIPULSE_TLS_NAMES` is checked against the SANs only — the subject CN is never used, so a CN-only certificate is `degraded-san`.

| Case          | Startup     | Reload                          | `/api/health`       | Docker server health            |
| ------------- | ----------- | ------------------------------- | ------------------- | ------------------------------- |
| Refused cases | refuse      | keep old context                | —                   | —                               |
| `degraded-*`  | start, warn | only if equal or better (below) | `degraded` + reason | fails if the client check fails |
| `valid`       | start       | yes                             | `ok`                | passes                          |

Generated leaves are verified against the generated CA before activation. For operator material the configured `PIPULSE_TLS_CA` (or system store) is the trust source; the managed CA plays no part.

### Validity at startup

- `expired` or `not-yet-valid`: start, with a `SEVERE` log line on every start and health `degraded`.
- `PIPULSE_TLS_REQUIRE_VALID_CERT=true` refuses them instead — except `not-yet-valid` while the clock isn't `synced`, which starts anyway (an unsynced clock must not brick the Pi).

### Files

- **Generated files (strict):** opened with `O_NOFOLLOW`; `fstat` on the fd must show a regular file with the expected owner and mode (native `root:pipulse`; Docker root owner with group `pipulse` by GID). Read from that same fd.
- **Operator files:** symlinks allowed (secret volumes, certbot's `live/` links). Open, `fstat` the fd (regular file, readable by the process, key not world-readable), read that fd. Owner is not checked. No check-then-read gap.
- **Atomic writes:** temp file created with `O_EXCL` in the same directory, owner and final mode set with `fchown`/`fchmod` before any content (under `umask 077`); write, `fsync`, `rename`, `fsync` the directory. Permissions are never broader, even briefly.
- Key paths and contents are never logged; errors name the setting, not the file content.

### Clock

- `synced`: `/run/systemd/timesync/synchronized` exists (Pi OS uses systemd-timesyncd; Docker mounts the host's directory read-only at `/host-timesync`) **and** `now` is not before `CLOCK_FLOOR_MS` (2026-09-01) in `packages/tls/src/clock.ts` **and**, when a leaf exists, not before its `notBefore`.
- `unsynced`: the file is absent but timesyncd is present, or `now` fails the floor.
- `unknown`: no timesyncd at all (chrony, ntpd, or a container without the mount). **Treated as not synced everywhere** — renewal waits, certificate alerts stay undecided.
- `PIPULSE_TLS_CLOCK=trust` (for chrony/ntpd hosts) makes `unknown` count as synced; it is shown in `pipulse tls status` and the sidecar log.
- systemd's `After=time-sync.target` is ordering only, never taken as proof.

### Reload provider

- Polls `stat` (inode, size, mtime) of the active source's files every 60 s; a change must be stable for two polls (debounce). No `fs.watch` (atomic rename-over and bind mounts make its events unreliable).
- Reads the files as one snapshot, runs the full startup validation, classifies the candidate, builds a `SecureContext`, then calls `server.setSecureContext()`.
- **Activates only a candidate that startup would also accept and whose class is equal to or better than the active one.** A valid active pair is never replaced by a degraded one; a changed fingerprint alone is never enough.
- On failure keeps the active context and records the error. If the active certificate has expired and the candidate is refused, health is `degraded` with reason `no-valid-reload`; collection is unaffected.
- Exposes `snapshot()`: source, active fingerprint, active class, validity, certificate age, `lastReloadAttempt`, `lastReloadError`, reload `ok|failing`.
- Logs on state changes; a repeated identical failure at most once per hour.
- The timer is `unref`'d and stopped on shutdown; it never keeps the process alive after `app.close()`.
- Writes `/run/pipulse/tls-status.json` (see [Local status channel](#local-status-channel)) on every change.

### One TLS client check

`packages/tls/dist/health-check.js` is used by the installer, the Docker `HEALTHCHECK` and `pipulse tls enable`, so there is one implementation:

- Connects to `127.0.0.1:<port>` (or `PIPULSE_HOST` when it isn't a wildcard), verifying the identity `healthTarget` picks: a concrete `PIPULSE_HOST` is verified as exactly that identity; a wildcard bind verifies the first `PIPULSE_TLS_NAMES` entry, else `localhost`, else `127.0.0.1`, else the first DNS SAN. The installer passes only the settings the check reads, via `env_value`, under `env -i`; it never sources `pipulse.env`, so `NODE_EXTRA_CA_CERTS` doesn't apply to it (trust is `PIPULSE_TLS_CA` alone when set, which replaces Node's roots, else Node's bundled Mozilla roots, not `/etc/ssl/certs`; Docker's `HEALTHCHECK` inherits the container environment).
- Trust follows the active source: generated → `<tls dir>/ca.crt`; operator → `PIPULSE_TLS_CA` alone, else Node's bundled roots. **Verification is never disabled.**
- Reads `/api/health` and requires `monitoring: "ok"`.
- Exit codes: `0` healthy; `1` PiPulse unhealthy or not answering; `2` TLS verification failed (reason printed).
- HTTP mode keeps the existing `curl` check.

## Server changes (`packages/api`)

Startup order in `server.ts` — TLS is checked before anything else starts, so a refusal is immediate and clean:

1. Resolve mode and source; in HTTPS mode load, parse, match and classify the certificate; refuse on any refused case.
2. Open the database; start scheduler, housekeeping, alerts and notifications as today.
3. `listen` with Fastify `https: { key, cert, minVersion: 'TLSv1.2' }` (full chain served). The WebSocket is `wss://` on the same server.
4. Log `listening on https://<host>:<port> (certificate: generated|operator, valid until <date>, SHA-256 <fp>)`; in HTTP mode `listening on http://… (HTTPS off: PIPULSE_TLS=off|legacy-http)`, plus a warning line when a password hash is configured.
5. Docker, 6b-2: write `/data/tls-installed` after TLS is validated and the server is listening (see [Docker](#docker-6b-2)).

- **Cookies:** already `Secure` when `request.protocol === 'https'`; tested over real HTTPS.
- **Origin check:** compares scheme + host; tested with `https://` origins.
- **Web client:** builds `ws:`/`wss:` from `location.protocol` (confirm nothing hard-codes `ws:`).

### HSTS

Off by default. RFC 6797 ignores the port: HSTS from `https://io:8889` forces every port on `io` to HTTPS in that browser — on `Io` that breaks Pi-hole's admin on `:80` and RPi-Monitor on `:8888`, and `tls disable` couldn't undo it until `max-age` expired.

- `PIPULSE_TLS_HSTS=<duration>` (the shared duration parser) opts in: `Strict-Transport-Security: max-age=<seconds>`, never `includeSubDomains`, never `preload`.
- Sent only on HTTPS responses, tied to HTTPS mode (not to certificate validity); never over HTTP.
- Integration-tested: absent by default, present when opted in, never on HTTP.

### `/api/health`

`/health` (bare liveness since Phase 0) stays unchanged; `/api/health` is the operational one. It stays public (in `PUBLIC_READS`, unaffected by `PIPULSE_PROTECT_READS`) and returns only enums — no paths, fingerprints, SANs or configuration:

```json
{
  "status": "degraded",
  "monitoring": "ok",
  "transport": "https",
  "certificate": {
    "source": "generated",
    "validity": "expired",
    "clockSynced": "synced",
    "class": "valid",
    "reload": "ok",
    "renewal": "ok"
  },
  "reasons": ["expired"]
}
```

`reasons` is top-level and lists every reason (including `http-with-sign-in`). `certificate` has no `parse`/`keyMatch`: the served pair is always ok, because refused material never serves; a refused replacement shows as `reload`, which is `ok | failing | no-valid-reload`. `renewal` is added to `certificate` in 6b-2.

- `200 ok`: monitoring running, transport usable, certificate `valid` and not expired.
- `200 degraded`: monitoring running, and any of: expired / not yet valid, a `degraded-*` class, reload `failing`, renewal `failing`, clock `unknown`/`unsynced` with a generated source, HTTP mode with sign-in configured.
- `503 failing`: database unavailable, no reading for 5 minutes (existing), the alert engine hasn't finished a check in 2 minutes. Failed deliveries don't count (a receiver being down isn't PiPulse failing), and the sender never stops except on shutdown: every delivery loop catches its errors, so there is nothing to detect. **An expired certificate alone is never `503`.**
- `transport: "http"` omits `certificate`.
- The existing `ok`/`problems` behaviour moves under `monitoring`; the installer's check moves to `"monitoring":"ok"`, and still accepts a body with `"status":"ok"` and no `monitoring` field, so a rollback to a pre-6b version is recognised as healthy.

### `/api/config`

Gains `tls` (subject to read protection): mode, source, leaf SANs, leaf and CA SHA-256, `notBefore`/`notAfter`, class and reasons, certificate age, reload state and last error, renewal status, clock state; in 6b-2 also CA constraints, CA backups and the coverage lines.

### Settings page — Certificate section

- Mode, source, validity with expiry and days left, SANs, leaf SHA-256, reload status and last error.
- HTTP mode: a banner saying traffic is readable on the network, stronger when sign-in is on; for `legacy-http` also "HTTPS is ready: run `sudo pipulse tls enable`".
- 6b-2 adds: CA fingerprint, effective constraints, renewal status, and the coverage lines:
  - DNS access: covered (`io`, `io.local`, …)
  - IP access: not covered / covered for `192.168.1.0/24`
  - Certificate warning expected: yes / no (per how the page was reached)
  - How to change scope: `sudo pipulse tls new-ca --subnet <cidr>`

## Certificate expiry alerts (6b-2)

`packages/alerts` gains a second input family, evaluated outside the metric-window code:

```ts
type EpochMs = number;
interface AlertContext {
  certificate?: { notAfter: EpochMs; clockSynced: boolean };
}
```

`alerts` defines this shape itself and imports nothing from `tls` or `api`. Each 15 s check, `server.ts` passes `{ certificate: provider.snapshot() mapped to that shape }` (`clockSynced` true only for `synced`, or `unknown` with `PIPULSE_TLS_CLOCK=trust`).

**Conditions** (both parsed by `parseRuleEntry`; neither takes `metric`, `for` or `clearAfter` — rejected if present; `longestLookBack` counts them as 0):

- `{ certExpiresWithin: "<duration>" }`: duration strictly positive; true when `0 < notAfter − now ≤ threshold`.
- `{ certExpired: true }`: true when `notAfter ≤ now`.

**Built-ins**, in force only when the resolved mode is HTTPS: `cert_expiring` (warning, `certExpiresWithin: 14d`) and `cert_expired` (critical, `certExpired`). They never overlap: at expiry the warning clears and the critical raises in the same check; the outbox order is `cert_expiring` clear, then `cert_expired` raise.

**Evaluator:** pure `evaluateCertificate(rule, certificate, now, open)`:

| Situation                      | Decision                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| HTTPS off                      | Rules not in force; an open row closes as `rule_removed` at the next start (no notification) |
| HTTPS on, `certificate` absent | `unavailable`: no raise, no clear; logged once per state change                              |
| `clockSynced: false`           | `undecided`: open stays open, closed stays closed — **never a clear**                        |
| synced, condition true         | raise, or keep open                                                                          |
| synced, condition false        | clear (`clearedBy: condition`), or keep closed                                               |

- Synced → unsynced (a reboot without RTC) freezes the state; a restart while unsynced keeps an open alert open and raises nothing new.
- Renewal moves `notAfter`; the next synced check clears.
- `rule_hash` covers only the rule: a new certificate never causes `rule_changed`; editing the threshold does.
- HTTPS → HTTP → HTTPS with an expired certificate: `rule_removed`, then `cert_expired` raises again with the same hash.
- The editor offers "Certificate expires within" (a duration field only) and "Certificate expired".
- These alerts are not the only certificate signal: unparseable or refused material produces no alert by design, so health, Settings and logs report it.

## Generated trust (6b-2)

### Layout (native)

| Path                  | Owner          | Mode            | Content                                              |
| --------------------- | -------------- | --------------- | ---------------------------------------------------- |
| `/etc/pipulse/tls/`   | `root:pipulse` | `2750` (setgid) |                                                      |
| `…/ca/`               | `root:root`    | `0700`          | `ca.key` (`0600`), `ca.crt`, `constraints.json`      |
| `…/ca.old-<ts>/`      | `root:root`    | `0700`          | up to two previous CAs                               |
| `…/ca.crt`            | `root:pipulse` | `0644`          | copy for server, clients, export                     |
| `…/ca-meta.json`      | `root:pipulse` | `0644`          | CA fingerprint, constraints, created-at, backup list |
| `…/leaf.pem`          | `root:pipulse` | `0640`          | serving bundle: PKCS#8 key + chain                   |
| `…/leaf.crt`          | `root:pipulse` | `0644`          | public copy of the leaf                              |
| `…/state.json`        | `root:pipulse` | `0640`          | mode                                                 |
| `…/renew-status.json` | `root:pipulse` | `0644`          | last renewal attempt                                 |
| `…/txn.json`          | `root:root`    | `0600`          | journal, only during a CA transaction                |

The setgid bit on the directory makes new files inherit group `pipulse`, so renewal writes need no `chown`. The CA key is never group-readable. The service can read `leaf.pem` through its group but never write anything here (`ProtectSystem=strict`).

### Name constraints

Critical `nameConstraints` on the CA, fixed for its lifetime:

- **Always permitted DNS:** `<hostname>`, `<hostname>.local`, `localhost`, plus `PIPULSE_TLS_NAMES` (read at CA creation).
- **Always permitted IP:** `127.0.0.1/32`, `::1/128`.
- **Subnets:** only by explicit operator choice — the interactive prompt, `--subnet`, or `PIPULSE_TLS_SUBNETS` (Docker: the only way). At most what the operator accepted.
- **Names-only default:** every other IPv4 and IPv6 address is excluded (`excludedSubtrees` `0.0.0.0/0` and `::/0` after the permits; RFC 5280 applies constraints per name type, so leaving IPs out would leave them unconstrained).
- **Rejected subnets:** broader than `/16` (IPv4) or `/48` (IPv6), `/0`, unspecified, multicast, broadcast, loopback beyond the fixed entries, link-local, IPv4-mapped or unusual IPv6 forms (checked after canonicalising). Container bridges (`docker*`, `br-*`, `veth*`), VPNs (`tun*`, `wg*`) are skipped by detection; an explicit override naming one is accepted with a warning.
- **Candidate detection:** the interface holding the default route (`/proc/net/route`, `/proc/net/ipv6_route`); its IPv4 network (normally `/24`).
- **The consequence text**, shown before any subnet is accepted and in `status`:

  > This CA will be trusted for the following DNS names and IP ranges. Anyone holding its private key can impersonate hosts within those ranges.
  >
  > Accepting 192.168.1.0/24 allows this CA to issue certificates for any IP in that subnet. A stolen CA key could impersonate other devices there.

- The effective constraints are stored in `constraints.json`/`ca-meta.json` and shown next to the CA fingerprint in the installer, `status` and Settings.
- Constraints never change. Widening means `new-ca`: old vs new constraints shown, confirmation, a new CA and leaf, and a notice that every client must trust the new CA.

### Issuance

- Names become canonical LDH labels (IDNs as punycode) and IPs are parsed and re-serialised; only those canonical values reach the generated `openssl` config. Tests cover hostile names (spaces, commas, `=`, newlines, `$`, very long labels).
- `openssl` runs via `execFile` with a fixed argv and a 30 s timeout; never through a shell.
- **CA:** ECDSA P-256, 10 years, `basicConstraints critical CA:TRUE, pathlen:0`, `keyUsage critical keyCertSign, cRLSign`, critical `nameConstraints`.
- **Leaf:** ECDSA P-256, 90 days, `notBefore` 1 h back, `extendedKeyUsage serverAuth`. SANs:
  - DNS: hostname, `<hostname>.local`, `localhost`, `PIPULSE_TLS_NAMES`;
  - IP: `127.0.0.1`, `::1`, and the **default-route interface's** addresses that fall within accepted subnets (other interfaces ignored).
  - Anything outside the constraints is left out, with a warning naming the `new-ca` command.
  - No default route → a names-only leaf and a warning; never an empty or broad IP scope.
- Every generated leaf is verified against the CA before activation.

### `pipulse tls` commands

Everything except `status` needs root. Anything that changes trust or mode asks on a TTY or needs `--yes`. Every command except `status` first finishes or rolls back an unfinished journal.

- **`status [--json]`** — three separate blocks: **configured** (files, `state.json`, source, CA fingerprint and constraints from `ca-meta.json`, backups, leaf validity/SANs/fingerprint, coverage lines, clock state and whether `PIPULSE_TLS_CLOCK=trust` is set), **active** (from the status file) and **last reload / last renewal**. Works when the server is stopped.
- **`init [--subnet CIDR]`** — idempotent. Operator source configured → makes no managed CA, prints "operator certificate in use; managed CA not created". Otherwise makes the CA only if none exists (never replaces one), and issues a leaf if missing, refused, or not verifying against `ca/ca.crt`. A partial CA (key without cert, cert without key, mismatch) stops with a recovery instruction; a CA key is never regenerated silently.
- **`renew [--force]`** — issues a new leaf only when the clock is synced and either ≤ 30 days are left or the default-route address is missing from the leaf (`--force` skips the due check, not the clock gate). An address that disappeared never triggers early renewal; it drops off at the next due renewal. Unsynced clock → exit 0, "waiting for clock synchronization". Operator source → `not-due: operator certificate`. Writes `renew-status.json` (`lastAttempt`, `result: renewed|not-due|waiting-clock|failed`, `reason`).
- **`new-ca [--subnet CIDR]… [--name N]… [--prune-oldest]`** — a journalled transaction (below). Refuses when two backups already exist unless `--prune-oldest` names the one it will delete.
- **`restore-ca <dir>`** — the same transaction, restoring a backup and issuing a leaf from it.
- **`enable`** —
  1. verify CA and leaf exist and validate;
  2. show serving names, IP constraints, CA fingerprint;
  3. ask (TTY) or require `--yes`;
  4. write `state.json` `https` atomically;
  5. validate the resulting configuration;
  6. restart PiPulse;
  7. run the shared health check (must exit `0`) — systemd accepting the restart is not success;
  8. print the HTTPS URL and CA and leaf fingerprints;
  9. state that old `http://` bookmarks now fail.

  If step 7 fails: restore the previous `state.json`, restart, check the old transport, report failure.

- **`disable [--allow-insecure]`** — asks; the flag is required when a password hash is configured; writes `legacy-http`; keeps all TLS material; restarts; checks HTTP health.
- **`export-ca`** — prints the CA PEM and per-OS trust steps ("trust this CA", never "accept this certificate").
- **`sidecar-init`, `sidecar`, `sidecar-health`** — Docker only (below).

### CA transactions (journal)

`txn.json` records the state; each step is idempotent:

`staged` → `validated` → `active-ca-moved` → `new-ca-installed` → `leaf-installed` → `committed`

- Stage everything in `ca.next-<id>/`: CA key and certificate, constraints, leaf bundle, public copies.
- Recovery:
  - before `validated`: delete the stage;
  - `validated`, active not yet moved: leave the active CA untouched, discard the stage;
  - `active-ca-moved` or later: complete the staged generation (it was validated);
  - `committed`: remove the journal, keep the backup.
- `ca/` is the only authoritative CA, identified by its fingerprint (also in `constraints.json`); in generated mode `leaf.pem` counts only if it verifies against `ca/ca.crt`.
- A failure before the renames leaves the serving CA and leaf untouched.
- Fault-injection tests kill the process after every step and during each `fsync` and `rename`, then run recovery: the end state is always one consistent CA + leaf.

### Backups

- `ca.old-<ts>/` are `root 0700`; `status` lists each with fingerprint and date; at most two kept (never auto-deleted; `--prune-oldest` is explicit).
- Restoring: `sudo pipulse tls restore-ca <dir>` (issues a matching leaf).
- Docs: back up `/etc/pipulse/tls` as a secret — it holds CA private keys and is the device's trust identity; restoring it restores that identity.

### Local status channel

- The unit gets `RuntimeDirectory=pipulse` (`0750`). The server atomically writes `/run/pipulse/tls-status.json`: active source, fingerprint, class, `notAfter`, reload state, last error, `pid`, process start time (`/proc/<pid>/stat` field 22), `bootId`.
- The CLI checks owner and mode (per deployment), then treats the file as stale if the boot ID differs, the pid isn't running, or its start time differs (pid reuse). A running server with an unreadable or corrupt file is reported as `status-file-corrupt`, never as partial data.
- `/run` is tmpfs and `RuntimeDirectory` is removed when the service stops, crashes included.
- No session, no HTTP: `PIPULSE_PROTECT_READS` doesn't affect the CLI.

### Setup and migration (`setup.sh`)

Transactional: TLS material is made and validated first, `state.json` is written last, then the service is enabled or restarted.

- **Fresh install** (no `/opt/pipulse/app/version.json` before this install): `tls init` (interactive install: the subnet prompt first) → validate → `state.json` `https` → enable + start → the shared health check must exit `0` (on a fresh install any non-zero is a failure; generated certificates can't legitimately fail verification). Prints URL, CA fingerprint, constraints, `export-ca`. On failure: stops with `journalctl -u pipulse` and `pipulse tls status` hints; `https` stays selected; rerunning setup is idempotent and retries; `sudo pipulse tls disable --allow-insecure` is the deterministic recovery.
- **Upgrade from pre-6b** (a previous `version.json`, no `state.json`): `tls init` (names-only, never prompts) → `state.json` `legacy-http` → restart. Prints "HTTPS is ready: `sudo pipulse tls enable`". The server logs it on every start; Settings shows the banner.
- **Upgrade with `state.json`**: `init` fills in missing pieces only; mode, CA and operator choices are never touched; no new trust anchor.
- **Interrupted upgrade**: rerunning lands in the same state; every step checks what exists first.
- **Downgrade to pre-6b**: the old version ignores `/etc/pipulse/tls` and serves HTTP; re-upgrading resumes. Documented.
- **Removal**: `apt remove` / `install.sh --uninstall` keep `/etc/pipulse/tls`; `purge` / `--purge` remove it.
- **Installer modes**: interactive only when `install.sh` has a real terminal (`/dev/tty`) and isn't run from `apt`; it detects one candidate subnet, shows the consequence text, asks with default **No**; declined → names-only CA and the opt-in command. Unattended (apt, piped without a TTY, upgrades) never waits for input: names-only CA and a prominent follow-up with the `new-ca --subnet` command.

### Renewal units (native)

- `pipulse-tls-renew.timer`: `OnBootSec=5min`, `OnCalendar=daily`, `RandomizedDelaySec=6h`, `Persistent=true` (catch-up runs go through the same clock gate).
- `pipulse-tls-renew.service`: `Type=oneshot`, `User=root`, `ExecStart=/usr/bin/pipulse tls renew`, `After=time-sync.target network-online.target`, `TimeoutStartSec=2min`, and:
  - `UMask=0077`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `CapabilityBoundingSet=` (empty — setgid directory, root-owned files)
  - `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX AF_NETLINK` (netlink to read interfaces)
  - `ProtectSystem=strict`, `InaccessiblePaths=/var/lib/pipulse`, `TemporaryFileSystem=/etc/pipulse:ro`, `BindPaths=/etc/pipulse/tls`, `EnvironmentFile=-/etc/pipulse/pipulse.env` (read before sandboxing), so it sees neither the database nor the password hash, rules or notify files.
- The server picks up a new leaf within about two minutes (two stable polls).
- A renewal failure shows in `renew-status.json`, `status`, Settings and health (`renewal: failing` → `degraded`); expiry alerts fire only as real expiry approaches.

## Docker (6b-2)

```yaml
services:
  pipulse-tls-init: # one-shot: volume ownership and modes
    image: ghcr.io/seviyon/pipulse:<ver>
    command: ['pipulse', 'tls', 'sidecar-init']
    user: '0:0'
    cap_drop: [ALL]
    cap_add: [CHOWN]
    security_opt: ['no-new-privileges:true']
    read_only: true
    network_mode: none
    restart: 'no'
    volumes: [tls-ca:/tls-ca, tls:/tls]
  pipulse-tls: # CA, leaf, renewal
    image: ghcr.io/seviyon/pipulse:<ver>
    command: ['pipulse', 'tls', 'sidecar']
    user: '0:0'
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    read_only: true
    tmpfs: [/tmp]
    network_mode: host # the host's hostname and default-route address; opens no sockets
    env_file: [{ path: ./pipulse.env, required: false }]
    volumes:
      - tls-ca:/tls-ca # CA key: this service only
      - tls:/tls # leaf, state, metadata
      - pipulse-data:/data:ro # the legacy marker check only
      - /run/systemd/timesync:/host-timesync:ro # optional clock signal
    depends_on: { pipulse-tls-init: { condition: service_completed_successfully } }
    healthcheck: { test: ['CMD', 'pipulse', 'tls', 'sidecar-health'] }
    restart: unless-stopped
  pipulse:
    # image default user pipulse; never root
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    read_only: true
    tmpfs: [/tmp, /run/pipulse]
    volumes: [pipulse-data:/data, tls:/tls:ro, …existing read-only mounts…]
    depends_on: { pipulse-tls: { condition: service_healthy } }
volumes: { pipulse-data, tls, tls-ca }
```

- **The server container never runs as root and never mounts `tls-ca`.** The image sets `PIPULSE_TLS_DIR=/tls` and ships `/usr/bin/pipulse`.
- **Capabilities:** `CHOWN` only in the one-shot init (makes `/tls` `root:pipulse 2750` and `/tls-ca` `root 0700`); the recurring sidecar has none. Tests prove both run with exactly these; a missing permission is fixed through ownership, never by adding capabilities.
- **Sidecar first start, in order:** (1) recover any journal; (2) stage CA and leaf (names-only, or `PIPULSE_TLS_SUBNETS`; never inferred); (3) validate the complete set; (4) activate atomically; (5) write `state.json`; (6) mark ready — only then is it `healthy`, so the server starts. It fails before readiness → the server doesn't start. Then every 6 h it runs `renew`.
- **Out-of-band channel:** the sidecar prints the CA fingerprint, constraints and `export-ca` instructions to `docker compose logs pipulse-tls` on every start (identical each time; the CA persists in `tls-ca`).
- **Sidecar health:** `healthy` = a valid leaf and renewal `ok` or `waiting-clock` (waiting is visible in its log and `status`); `unhealthy` = renewal `failing` or no valid leaf. Compose doesn't stop or restart the server for that (documented); the server keeps serving the last valid leaf if the sidecar exits.
- **Network trust note (docs):** the sidecar shares the host network to see the hostname and default-route address. It opens no sockets, but nothing in Docker prevents a compromised sidecar from connecting out — a code-level guarantee, not a container boundary. Tests: no `net`/`http`/`https`/`fetch`/`dgram` in its module graph, and `strace -f -e trace=socket,connect` over `init`/`renew` shows no `AF_INET`/`AF_INET6` sockets (netlink only).
- **Clock:** no mounted timesync → `unknown` → renewal waits; `PIPULSE_TLS_CLOCK=trust` in `pipulse.env` for chrony/ntpd hosts.
- **Legacy marker:** the sidecar decides the mode only when `/tls/state.json` is absent: `/data/pipulse.sqlite` exists **and** `/data/tls-installed` doesn't → `legacy-http`; otherwise `https`. The server writes `/data/tls-installed` (its own writable data volume) only after TLS is validated and it is listening. The marker's only job: a lost `tls` volume with surviving data must not silently fall back to HTTP. It checks file existence only, never opens SQLite. Copying an old database into a fresh setup copies its migration history and is treated as an upgrade (documented).
- **Changing scope:** `docker compose run --rm pipulse-tls pipulse tls new-ca --subnet … --yes` (same journal).
- **Status:** `docker compose exec pipulse pipulse tls status` runs in the server container, reading `/run/pipulse/tls-status.json` and `/tls` read-only (`ca-meta.json`, never `ca.key`).
- **Server `HEALTHCHECK`:** the shared check (trust per the active source) must exit `0`.
- **Plain `docker run`** (no sidecar, no `/tls`): refuses with the fix line; the README shows mounting an operator certificate read-only, or `PIPULSE_TLS=off`.

## Testing

Vitest unless noted. Real Telegram delivery is never part of the automated suite.

- **`tls`:**
  - mode resolution matrix (the table above); `state.json` parser (unknown/duplicate keys, bad values);
  - PEM: every rejection case, key before/after certificates, CRLF, size and block limits, each operator key label, encrypted keys, key matching a later certificate only;
  - chain classes: every refused case, each degraded class, a CA-profile leaf, duplicate leaf, unrelated certificate, trailing data;
  - constraints: every rejected subnet form, IPv6 canonicalisation, candidate detection over fixture route tables (multiple interfaces; default route on one with addresses on another; DHCP change; IPv4-only; IPv6; bridges, VPNs, link-local; hostname change; no default route);
  - issuance: hostile names canonicalised or rejected; a generated CA+leaf verifies with `openssl verify` and Node;
  - journal fault injection (every step, every `fsync`/`rename`);
  - clock states including the build-time floor and `trust`.
- **Reload provider** (fake clock and fs): debounce; equal-or-better only; valid never replaced by degraded; failed candidate keeps the old context; `no-valid-reload`; rate-limited logging; the timer doesn't hold the process open after shutdown.
- **Local status channel:** server stopped (files still reported); file missing; stale pid; pid reuse (start-time mismatch); boot ID mismatch; corrupt JSON; partial write never observed; Docker access without `tls-ca`.
- **`api` over real HTTPS and `wss://`** (certificates from a test-CA fixture): `Secure` cookie; Origin with `https`; HSTS absent by default, present when opted in, never over HTTP; `/api/config` `tls`; full `/api/health` bodies for: healthy + valid (`200 ok`), healthy + degraded certificate (`200 degraded`), monitoring failing (`503 failing`), renewal failing with a valid served certificate, waiting for clock, no reloadable certificate (`no-valid-reload`), stale/corrupt runtime status, HTTP mode with sign-in; reload continuity — replacement and a refused replacement while a `wss` client stays connected, sampling and alert checks keep running, a queued notification is delivered.
- **`alerts`:** every evaluator table row; boundaries (exactly `notAfter`, ±1 ms, exactly on the threshold, 14 d − 1 ms); warning and critical never open together; warning clears and critical raises at expiry with the outbox order clear → raise; synced → unsynced → synced with the alert open and closed; restart while unsynced; clock unsynced during an already expired certificate; backward and forward clock jumps while synced; refused/missing certificate with an open alert keeps the row; renewal clears; threshold edit → `rule_changed`, certificate swap → none; HTTPS off/on transitions; parser rejects `metric`/`for`/`clearAfter` and a zero `certExpiresWithin`; look-back ignores both kinds.
- **`web`** (happy-dom): Certificate section per state; HTTP and `legacy-http` banners; coverage lines.
- **`packaging/test/*.test.sh`** (Debian containers): fresh install → HTTPS and health `0`; upgrade from a 0.6.2 install → `legacy-http` → `enable` → `disable --allow-insecure`; `PIPULSE_TLS=on` over `legacy-http` and `off` over `https`; operator source vs generated; an injected failed `enable` leaves the previous transport and state; a failed source switch leaves no mixed configuration; rerun idempotency (same CA fingerprint); `new-ca` with an injected crash, then recovery; `restore-ca`; backup limit and `--prune-oldest`; purge; the `strace` socket test; `systemd-analyze verify` on both units.
- **Docker test:** compose up healthy; volume owners and modes (`ca.key` `0600`, `leaf.pem` readable by the `pipulse` UID/GID); `tls-ca` not visible in the server container; the server can't write `/tls`; `/data/tls-installed` appears only after listening; a second start keeps the CA fingerprint; the init and sidecar containers run with exactly their capabilities; plain `docker run` refuses with the fix line.
- **Browser name-constraint check** (manual, recorded in the plan's results): after trusting the constrained CA as a root, test an allowed name, an allowed IP, a disallowed name and a disallowed IP separately (the latter two via leaves issued outside the constraints with the CA key) in Chrome, Firefox and macOS (Safari/system). Record browser and version, macOS version, trust-store location, CA fingerprint, constraints, leaf SANs, and whether each rejection was a hostname, constraint or trust error. A warning alone doesn't prove enforcement.

## Exit criteria

On `Io` (port 8889) unless noted. Before deleting any scratch state, capture `/api/health`, `/api/config` (`tls`), `pipulse tls status --json`, `/api/alerts?state=all` and the notification outbox.

### 6b-1

1. An operator certificate with a full chain from a test CA serves `https://io:8889`; the dashboard goes Live over `wss://`; the session cookie is `Secure`.
2. A replacement certificate is picked up without a restart (the fingerprint in `/api/config` changes) while a `wss` client stays connected and readings keep arriving.
3. A refused replacement (key mismatch) and a malformed chain are rejected; the old context keeps serving; a degraded replacement doesn't replace a valid active certificate.
4. An expired certificate: PiPulse starts with `SEVERE`, health `200 degraded`, collection and alert checks continue; with `PIPULSE_TLS_REQUIRE_VALID_CERT=true` it refuses.
5. The installer's check is green over verified TLS; an upgrade with a certificate problem warns without rolling back.

### 6b-2

1. A fresh apt install serves HTTPS with a names-only CA; the CA fingerprint and constraints are printed during install; `pipulse tls status` output recorded.
2. After trusting the CA on the Mac, `https://io:8889` and `https://io.local:8889` load without a warning; `https://192.168.1.x:8889` shows one.
3. `sudo pipulse tls new-ca --subnet 192.168.1.0/24`: constraints captured before and after; after trusting the new CA the IP URL loads without a warning. `restore-ca` returns to the first CA (fingerprint changes back).
4. An interrupted `new-ca` (killed mid-transaction) recovers to one consistent CA + leaf on the next command.
5. A DHCP-style change (a new address on the default-route interface, then `renew`) issues a leaf covering it, still trusted, with no restart.
6. An upgrade from 0.6.2 stays HTTP with the banner; `pipulse tls status` before; `enable` → HTTPS verified, status after; `disable --allow-insecure` → HTTP.
7. After `reboot`, the renew timer runs and waits for the clock (`waiting-clock` recorded), then renews once synced.
8. A renewal failure (made to fail) while the leaf is still valid shows `renewal: failing` in status, Settings and health; the site keeps working.
9. With a short-lived test leaf: `cert_expiring` raises before expiry; at expiry `cert_expiring` clears and `cert_expired` raises — persisted alert rows and outbox sequence captured, and both arrive on Telegram in that order (manual).
10. The renew unit can't read the database, the password hash, the rules file or the notify file (asserted under the real unit); address enumeration works under it.
11. Docker on a 64-bit host: compose up healthy; the sidecar made unhealthy (renewal failing) doesn't restart or stop the server; after the sidecar is stopped the server keeps serving the last valid leaf; without the timesync mount the clock is `unknown` and renewal waits; with `PIPULSE_TLS_CLOCK=trust` it renews.

## Documentation

- README: replace "Plain HTTP, for now" with an HTTPS section — trusting the CA per OS (with the fingerprint check), names vs IP scope and the consequence text, the `pipulse tls` commands, operator certificates, `PIPULSE_TLS=off`, HSTS opt-in and why it's off, the Docker network trust note, and three operational warnings:
  - an expired certificate can lock browsers out while collection and notifications continue;
  - HSTS persists in browsers and affects other services on the same hostname, hence opt-in;
  - the CA private key is a secret; backing up `/etc/pipulse/tls` preserves the device's trust identity.
- `docs/PLAN.md`: 6b decisions; "Future: behind a reverse proxy" updated.
- `CLAUDE.md`: status and conventions.
- `packaging/pipulse.env`: the new settings (`PIPULSE_TLS`, `PIPULSE_TLS_CERT`/`KEY`/`CA`, `PIPULSE_TLS_NAMES`, `PIPULSE_TLS_SUBNETS`, `PIPULSE_TLS_CLOCK`, `PIPULSE_TLS_HSTS`, `PIPULSE_TLS_REQUIRE_VALID_CERT`).
- `docs/RELEASING.md`: 6b-1 → `v0.6.3`, 6b-2 → `v0.7.0`.

## Settings reference

| Setting                               | Default                            | Meaning                                                                 |
| ------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `PIPULSE_TLS`                         | unset                              | `on`/`off`; overrides `state.json`                                      |
| `PIPULSE_TLS_DIR`                     | `/etc/pipulse/tls` (Docker `/tls`) | generated material and state                                            |
| `PIPULSE_TLS_CERT`, `PIPULSE_TLS_KEY` | unset                              | operator certificate (both or neither)                                  |
| `PIPULSE_TLS_CA`                      | unset                              | trust for operator certificates (health check, chain class)             |
| `PIPULSE_TLS_NAMES`                   | unset                              | extra DNS names (read at CA creation; leaf limited to constraints)      |
| `PIPULSE_TLS_SUBNETS`                 | unset                              | accepted subnets at CA creation (Docker: the only way)                  |
| `PIPULSE_TLS_CLOCK`                   | unset                              | `trust`: treat an `unknown` clock as synced                             |
| `PIPULSE_TLS_TIMESYNC_DIR`            | `/run/systemd/timesync`            | where the clock signal is read (the Docker image sets `/host-timesync`) |
| `PIPULSE_TLS_HSTS`                    | unset                              | opt-in HSTS `max-age`                                                   |
| `PIPULSE_TLS_REQUIRE_VALID_CERT`      | `false`                            | refuse to start on an expired / not-yet-valid certificate               |
