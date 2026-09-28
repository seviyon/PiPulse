# Phase 6 — Packaging: design

Status: approved in brainstorming on 2026-09-28; this document is for review before the implementation plan.

Until now PiPulse has run from a git checkout with a per-user Node (nvm) and hand-typed environment variables. This phase makes it installable, upgradable and removable like any other service on a Pi, and keeps it — and everything it depends on — up to date with little effort, ready for Phase 7 to replace RPi-Monitor on `Io`.

## Goal

- **Three ways to install**, all from GitHub, all with the same result on disk:
  - a one-line installer that adds a signed apt repository and installs the `pipulse` package, after which `apt upgrade` keeps it current (the way RPi-Monitor was installed);
  - a release tarball with its own `install.sh`, for systems without apt and for testing a build before it is released;
  - a Docker image for 64-bit hosts (`arm64`, `amd64`).
- **Its own Node.** Native installs carry a private, verified Node under `/opt/pipulse/node`, never touching the system Node (`Io`'s `/usr/bin/node` is 16 and stays that way).
- **Nothing goes stale.** Renovate keeps every npm package, GitHub Action, the Docker base image and the bundled Node versions current; merged updates are released automatically; an apt-installed Pi picks them up with `apt upgrade`.
- **Versioned.** Every release has a version PiPulse itself reports, starting at `v0.6.0`.

**Success:** see [Exit criterion](#exit-criterion).

## Scope

In scope: `packaging/` (installer, shared setup script, systemd unit, env template, `.deb` hooks, `pipulse` command, Node version pins and release keys), a `Dockerfile` and `compose.yaml`, a `release.yml` workflow, packaging checks in `ci.yml`, `renovate.json`, the signed apt repository on GitHub Pages, and the small app changes in [Changes inside PiPulse](#changes-inside-pipulse).

Out of scope:

- The Pi updating itself unattended. Releases reach a Pi only when the operator installs them (`apt upgrade`, re-running `install.sh`, pulling the image); turning on `unattended-upgrades` for the PiPulse repository is the operator's choice per Pi.
- Docker on 32-bit Pis. 32-bit Pis use the apt or tarball path.
- `armv6` (Pi 1, Pi Zero): refused by the installer.
- apt for other distributions or multiple channels: one `stable` suite.
- TLS or a reverse proxy (see "Future: behind a reverse proxy" in `docs/PLAN.md`).
- Phase 7's cutover from RPi-Monitor.

## Versions and releases

- **One version for the whole product.** The seven workspace packages are one app. Their `package.json` files stay at `0.0.0` in git; the release build stamps the version into the artifacts only, so no workflow ever commits to `main`.
- **Start at `v0.6.0`** with the first Phase 6 release. No back-dated tags for Phases 0–5 (they would be releases with nothing to install; their merged PRs are the record). `1.0.0` is for after Phase 7.
- **Releases come from PR labels.** A PR merged into `main` with `release:patch`, `release:minor` or `release:major` produces the next version from the latest `v*` tag (`v0.6.0` when there is none); a PR without one produces no release. Renovate labels its PRs `release:patch`. A manual "run now" (`workflow_dispatch`) releases a given version without a PR, e.g. after a failed run.
- Release notes are GitHub's generated notes from the merged PRs' titles.

## Artifacts

Each release publishes, as GitHub Release assets:

| Asset                                                     | Contents                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pipulse-<version>.tar.gz`                                | Every package's `dist/`, the built dashboard, production `node_modules`, `packaging/`, `install.sh`. The same for every CPU: PiPulse has no native add-ons (SQLite is built into Node; Fastify, Preact and the rest are plain JavaScript). |
| `pipulse_<version>_armhf.deb`, `_arm64.deb`, `_amd64.deb` | The tarball's contents plus that CPU's Node.                                                                                                                                                                                               |
| `install.sh`                                              | The one-line installer (also inside the tarball).                                                                                                                                                                                          |
| `compose.yaml`                                            | The Docker setup.                                                                                                                                                                                                                          |
| `SHA256SUMS`, `SHA256SUMS.asc`                            | Checksums of all of the above, signed with the apt repository key.                                                                                                                                                                         |

Plus the Docker image `ghcr.io/seviyon/pipulse:<version>` and `:latest` (`linux/arm64`, `linux/amd64`), and the apt repository update.

## Node

| CPU (`dpkg --print-architecture`)                  | Node line                                                                                               | Security support until |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| `armhf` (32-bit Pi OS: Pi 2, and Pi 3/4 on 32-bit) | 22 LTS — the last line with official 32-bit ARM builds; none exist for 24 or 26, official or unofficial | 2027-04-30             |
| `arm64`, `amd64`                                   | 24 LTS, moving to 26 once that is LTS                                                                   | 2028-04-30 (24)        |

- The exact versions live in `packaging/node-versions.json` (`{"armhf": "22.x.y", "arm64": "24.x.y", "amd64": "24.x.y"}`), bumped by Renovate. A Renovate rule keeps `armhf` below 23.
- **Verification without stored checksums.** The Node release team's public keys are kept in `packaging/node-keys/`. Every download of Node — in the release build and in `install.sh` — first fetches `SHASUMS256.txt` and `SHASUMS256.txt.sig`, checks the signature with `gpgv` against those keys, then checks the Node archive against the list. A tampered list or a signature by another key stops the build or install. Because nothing but the version string is in the repository, Renovate can bump it on its own.
- **Why the CPU comes from `dpkg`:** a Pi 4 running 32-bit Pi OS on a 64-bit kernel reports `aarch64` from `uname -m`, but its userland needs 32-bit Node.
- **End of support is shown, not hidden** (see [Changes inside PiPulse](#changes-inside-pipulse)). After 2027-04-30 a 32-bit Pi keeps working on an unpatched Node 22; the docs say so and name the options: move PiPulse to a 64-bit Pi, or accept the risk (PiPulse is LAN-only and its network surface is the dashboard, sign-in and outbound webhooks).

## Layout on a native install

The tarball and `.deb` install exactly the same things:

| Path                              | Contents                                                                                                                | Owner, mode                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/opt/pipulse/app/`               | The app, one version at a time (plus `version.json`)                                                                    | root, read-only                                                                                               |
| `/opt/pipulse/node/`              | The private Node                                                                                                        | root, read-only                                                                                               |
| `/usr/bin/pipulse`                | The `pipulse` command (below)                                                                                           | root                                                                                                          |
| `/etc/pipulse/pipulse.env`        | Settings: `PIPULSE_*`, `NODE_EXTRA_CA_CERTS`                                                                            | `root:pipulse 640`                                                                                            |
| `/etc/pipulse/`                   | Where the operator puts the password hash, rules file, notify file and any CA certificate; `pipulse.env` points at them | folder `root:pipulse 750`; files the operator adds should be `root:pipulse 640` (the service only reads them) |
| `/var/lib/pipulse/pipulse.sqlite` | The database                                                                                                            | `pipulse 600` (folder `pipulse 700`)                                                                          |
| `pipulse.service`                 | `/etc/systemd/system/` (tarball) or `/lib/systemd/system/` (`.deb`)                                                     | root                                                                                                          |

`pipulse` is a system user with no login shell, home `/var/lib/pipulse`, in the `video` group when that group exists (needed for `vcgencmd`). The default port stays 8888; on `Io`, `pipulse.env` sets 8889 until Phase 7.

## `packaging/setup.sh` (shared)

Called by `install.sh` and by the `.deb`'s `postinst`, so the two paths cannot drift. Idempotent; every step is safe to repeat:

1. Create the `pipulse` user and group if missing; add it to `video` if that group exists.
2. Create `/etc/pipulse` and `/var/lib/pipulse` with the owners and modes above (fixing them if wrong).
3. Write `/etc/pipulse/pipulse.env` from the template **only if it doesn't exist**.
4. Where systemd is running: install the unit (tarball path) and `systemctl daemon-reload`. On a **first install** (`--first-install`: the `.deb`'s `postinst` with no previous version, or `install.sh` with nothing installed yet), `enable` and start it. On an upgrade, respect the operator's choice: restart it only if it is enabled; leave a disabled or masked unit alone and say so (never fail the upgrade over it). Without systemd (a container), skip this and say so.
5. Warn, never change anything: if ufw is active and the configured port has no allow rule, print the exact `sudo ufw allow from <LAN> to any port <port> proto tcp` line; if another process already listens on the port (as RPi-Monitor does on 8888 on `Io`), name it and say where to change `PIPULSE_PORT`.

## `install.sh`

```bash
curl -fsSL https://github.com/seviyon/PiPulse/releases/latest/download/install.sh | sudo bash
```

- **Default (apt):** on a system with apt, it adds the PiPulse apt repository (key to `/usr/share/keyrings/pipulse.gpg`, source to `/etc/apt/sources.list.d/pipulse.list`, `signed-by` that key only), runs `apt-get update` and `apt-get install pipulse`. Upgrades then come from `apt upgrade`.
- **Tarball mode:** `--tarball` installs from the latest release's tarball instead of apt; `--version X.Y.Z` picks a release; `--from <file>` uses a local tarball (the pre-release test path; implies tarball mode). It checks the tarball against the release's `SHA256SUMS` (not needed with `--from`, where the operator supplied the file), fetches and verifies Node as above, and calls `setup.sh`.
- **Upgrade with rollback (tarball mode):** unpack to `app.new` / `node.new`, move the current ones to `app.previous` / `node.previous`, swap in the new ones, restart, and wait up to 30 s for `/api/health` to answer `200` on the port (and host, unless it is `0.0.0.0`) set in `pipulse.env`. Before swapping, the service is stopped and the database (with its `-wal`/`-shm`) is copied aside, because a new version may migrate it and the previous version refuses a newer schema. If the new version doesn't become healthy, stop it, restore the database copy, put the previous version (and, through its own `setup.sh`, its unit) back, start it, **check its health again**, and report honestly which version is running and whether it is healthy; exit non-zero either way. Each health request times out after 3 s. `app.previous` and the database copy are removed after a successful upgrade. When the operator has disabled or masked the service, the upgrade installs without starting or checking it.
- **Removing (tarball mode):** `--uninstall` stops and disables the service and removes `/opt/pipulse`, `/usr/bin/pipulse` and the unit, keeping `/etc/pipulse` and `/var/lib/pipulse`; `--purge` also removes those and the `pipulse` user. (An apt install is removed with `apt remove` / `apt purge`.)
- Refuses: `armv6` (checked with `uname -m`, since Raspbian reports `armhf` on a Pi 1 or Zero too; the `.deb`'s `preinst` refuses as well), an install that apt manages (for `--tarball`, `--uninstall`, `--purge`: use apt), running without root, and tarball mode without a running systemd unless `--no-start` is given (then it installs, runs `setup.sh`, and skips starting and the health check; CI uses this in containers).
- **Safe to pipe into a shell:** the whole script is one `main` function called on its last line, so a truncated download runs nothing. The README also shows the two-step form (download, read, run).

## `.deb`

- Package `pipulse`, one per CPU, built with `dpkg-deb` and checked with `lintian` in CI.
- `/etc/pipulse/pipulse.env` is a conffile (apt asks before replacing an edited one).
- `postinst configure` runs `setup.sh`; `prerm` stops the service; `postrm purge` removes `/etc/pipulse`, `/var/lib/pipulse` and the `pipulse` user. `apt remove` keeps data and settings.
- Depends only on what Pi OS always has (`systemd`, `adduser`); Node is inside the package.

## Apt repository

- Published by the release workflow to the `gh-pages` branch, served at `https://seviyon.github.io/PiPulse/apt`: suite `stable`, component `main`, architectures `armhf arm64 amd64`, keeping the last 3 versions per architecture in the pool.
- `InRelease` and `Release.gpg` signed with a dedicated GPG key whose private half is a repository secret; its public half is published as `https://seviyon.github.io/PiPulse/apt/pipulse.gpg`.
- Manual setup, as the README shows it:

```bash
curl -fsSL https://seviyon.github.io/PiPulse/apt/pipulse.gpg | sudo tee /usr/share/keyrings/pipulse.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/pipulse.gpg] https://seviyon.github.io/PiPulse/apt stable main" | sudo tee /etc/apt/sources.list.d/pipulse.list
sudo apt update && sudo apt install pipulse
```

## `pipulse.service`

```ini
[Unit]
Description=PiPulse system monitor
After=network-online.target
Wants=network-online.target

[Service]
User=pipulse
Group=pipulse
SupplementaryGroups=video
Environment=PIPULSE_DB_PATH=/var/lib/pipulse/pipulse.sqlite
Environment=PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist
Environment=NODE_OPTIONS=--disable-warning=ExperimentalWarning
EnvironmentFile=/etc/pipulse/pipulse.env
ExecStart=/opt/pipulse/node/bin/node /opt/pipulse/app/packages/api/dist/server.js
WorkingDirectory=/var/lib/pipulse
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/pipulse
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

- `EnvironmentFile` comes after the defaults, so `pipulse.env` can override them.
- `PrivateDevices` stays off: `vcgencmd` needs `/dev/vchiq`. `ProtectHome` is fine because nothing PiPulse reads lives in a home folder.
- Every hardening line is checked on `Io` (`systeminformation` runs helper programs such as `df`); a line that breaks a reading is dropped and the reason noted next to the unit.
- `TimeoutStopSec=20` fits the shutdown limits: the collector's 5 s and the notification sender's 5 s (below).

## `/etc/pipulse/pipulse.env`

A commented template, `packaging/pipulse.env`, listing every variable with its default commented out: `PIPULSE_HOST`, `PIPULSE_PORT`, `PIPULSE_ALLOWED_ORIGINS`, the four `PIPULSE_RETENTION_*`, `PIPULSE_ALERTS_FILE`, `PIPULSE_ADMIN_PASSWORD_HASH_FILE`, `PIPULSE_PROTECT_READS`, `PIPULSE_NOTIFY_FILE`, and `NODE_EXTRA_CA_CERTS`, with example paths under `/etc/pipulse/`. PiPulse itself never reads this file: systemd (and compose's `env_file`) turn it into environment variables, so the app's configuration is unchanged.

## The `pipulse` command

`/usr/bin/pipulse`, a short shell script installed by both native paths. It loads `/etc/pipulse/pipulse.env` and runs the private Node with the ExperimentalWarning silenced:

- `pipulse version` — PiPulse and Node versions and Node's end of support.
- `sudo pipulse notify-test [id]` — `notify-test` with the service's settings (including `NODE_EXTRA_CA_CERTS`). Runs as the `pipulse` user so it reads the files exactly as the service does.
- `pipulse hash-password` — prints a hash for `PIPULSE_ADMIN_PASSWORD_HASH_FILE`.

## Docker

64-bit only: `linux/arm64` and `linux/amd64`.

- **`Dockerfile`, two stages.** Stage 1 (on the build machine's own CPU, since the output is plain JavaScript): `npm ci`, build, prune to production dependencies, write `version.json`. Stage 2: `node:24-bookworm-slim` pinned by digest (Renovate bumps it), the app copied in, a non-root `pipulse` user, `/data` as a volume, `PIPULSE_DB_PATH=/data/pipulse.sqlite`, `PIPULSE_HOST_ROOT=/host`, `PIPULSE_IN_CONTAINER=true`, the ExperimentalWarning silenced, and a `HEALTHCHECK` on `/api/health` (below): `node -e` fetching `http://127.0.0.1:$PIPULSE_PORT/api/health` (the slim image has no curl), every 30 s, 5 s timeout, 3 retries, 60 s start period. Dockhand, Portainer and `docker ps` show it as the container's health.
- **Debian slim, not Alpine:** `systeminformation` runs GNU tools (`df` with options BusyBox lacks), so Alpine would break the disk readings.
- **`compose.yaml`**, commented so the host access isn't mistaken for over-privileging:

```yaml
services:
  pipulse:
    image: ghcr.io/seviyon/pipulse:latest
    restart: unless-stopped
    network_mode: host # the host's network counters and hostname; set PIPULSE_PORT in pipulse.env
    env_file: ./pipulse.env
    volumes:
      - pipulse-data:/data
      - ./config:/etc/pipulse:ro # password hash, rules, notify file, CA certificate
      - /boot/firmware:/boot/firmware:ro # the /boot usage tile (use /boot on older Pi OS)
      - /etc/os-release:/host/etc/os-release:ro # the host's OS name, not the image's
      - /proc/device-tree/model:/host/model:ro # the Pi model (Docker hides /sys/firmware)
volumes:
  pipulse-data:
```

- **No `pid: host`** (unlike the first sketch in `docs/PLAN.md`): CPU, memory, swap, swap I/O and load come from kernel-wide counters, and PiPulse lists no processes. **No `/dev/vchiq`** and no `vcgencmd` in the image: the core voltage and throttling tiles say "Not available in Docker". Temperature and CPU frequency come from `/sys`, which containers see.
- **Verification:** CI smoke-tests the image. A real-host check (every tile but the two `vcgencmd` ones matches a native install; network counters are the host's) is deferred to the Pi 5 and recorded as open in `docs/PLAN.md`.

## Changes inside PiPulse

1. **Version.** The release build writes `version.json` (`{"version": "0.6.0"}`) at the app root. The server reads it at startup; a development checkout has none and reports `dev`. `/api/config` gains `version` and `node: { version, line, supportEnds }` (`supportEnds` is a `YYYY-MM-DD` string or `null`). The startup log line becomes `[pipulse] 0.6.0 (Node 22.23.3) listening on …`.
2. **Node end of support.** A table in `packages/api` gives each line's end of security support (22 → 2027-04-30, 24 → 2028-04-30, 26 → 2029-04-30); an unknown line gets `null`, never a guess. Once the date has passed, startup logs one line (`[pipulse] Node 22 no longer gets security fixes (since 2027-04-30)`) and the Settings page shows a warning. Adding a new line to the table is on the checklist for a Node major bump (Renovate cannot know the date).
3. **About on the Settings page:** PiPulse version, Node version and its end of support; after that date a warning with an icon and words, not colour alone.
4. **Host root.** With `PIPULSE_HOST_ROOT` set, the device info reads the OS name (`PRETTY_NAME`) from `$PIPULSE_HOST_ROOT/etc/os-release` and the model from `$PIPULSE_HOST_ROOT/model` when those files exist, falling back to today's sources. Unset (native), nothing changes.
5. **In a container.** With `PIPULSE_IN_CONTAINER=true`, the server doesn't schedule the `cpu_voltage` and `throttled` plugins and lists them in `/api/config` with `unavailable: "Not available in Docker"`. Their tiles show that text instead of "No readings yet"; History leaves them out. The versioned `CollectorPlugin` interface doesn't change: the decision is the server's.
6. **Prompt shutdown** (the deferred minor from 5b-3). `notifications.stop()` aborts deliveries in progress (the same signal as their timeout, combined with `AbortSignal.any`) and waits at most 5 s. A delivery cut short by shutdown is not a failed attempt: its row stays pending, untouched, and the next start sends it at once.
7. **`GET /api/health`.** Always public — the auth hook allows it even with `PIPULSE_PROTECT_READS=true`, like `/api/session` — so a container manager or the installer can check it without signing in. It answers `200 {"status":"ok"}` when both hold, otherwise `503 {"status":"unhealthy","problems":[…]}` with short fixed strings:
   - **database:** reading the database header (`PRAGMA user_version`) succeeds (`"database unavailable"`);
   - **collector:** the scheduler has stored a reading (`"no readings yet"` until the first one, which comes within seconds — so a version that starts but can't collect never passes the installer's check) and did so within the last 5 minutes, measured on the monotonic clock so a wall-clock jump can't flip it (`"no readings for 5 min"`). A plugin that fails on its own doesn't count against it; only all collection stopping does.

   It reveals nothing else (no version, no host details), and it is cheap enough to run every 30 s on a Pi 2.

## CI and release workflows

**`ci.yml` (every PR and push to `main`), added jobs:**

- `shellcheck` on every script in `packaging/` and `install.sh`.
- Build the tarball and the `amd64` `.deb`; `lintian` the `.deb`.
- In a clean `debian:bookworm` container: `install.sh --from … --no-start` (no systemd), check the user, folders, modes and `pipulse.env`, start PiPulse from `/opt/pipulse` as the service would and require `/api/config` to answer with the stamped version; then the same for `dpkg -i` of the `.deb`.
- **Negative test:** a tampered `SHASUMS256.txt` and a list signed by a key not in `node-keys/` must each stop the Node download.
- Build the Docker image for `amd64`, run it, require its Docker health to reach `healthy`, `/api/config` to answer, and `cpu_voltage` to be listed unavailable.
- **Release dry-run:** a PR that touches `packaging/`, `Dockerfile`, `compose.yaml` or `.github/workflows/` runs the full release pipeline without publishing.

**`release.yml`:**

- Triggers: a PR merged into `main` with a `release:*` label, or `workflow_dispatch` with a version.
- **Only plain `X.Y.Z` versions are released** (a hyphenated one such as `0.7.0-rc.1` sorts above `0.7.0` in apt, so Pis that installed it would never upgrade to the real one).
- **The signing key never meets npm.** The workflow is one file (a tag pushed with `GITHUB_TOKEN` doesn't start other workflows) but several jobs: `version` and `build` (npm with `--ignore-scripts`, build, tests, tarball, `.deb`s) run with a read-only token that isn't kept in the checkout and no secrets; `image` can push to GHCR but has no signing key; `publish`, the only job with the key, runs no npm and no project code — it signs and publishes the files `build` handed over, and moves the image's `:latest` last. Steps:
  1. Compute the version; fail if its tag already exists.
  2. `npm ci`, build, test, stamp `version.json`, assemble the tarball.
  3. For each CPU: fetch and verify Node, build the `.deb`, `lintian`.
  4. Build and push the Docker image (`arm64`, `amd64`) to GHCR as `:<version>` and `:latest`.
  5. Update the apt repository on `gh-pages`: add the new `.deb`s, keep the last 3 per architecture, regenerate and sign the indexes.
  6. Write `SHA256SUMS`, sign it (`SHA256SUMS.asc`).
  7. Tag `v<version>` and publish the GitHub Release with the assets and generated notes.
  8. **Check what users get:** in a clean `debian:bookworm` container, add the apt repository exactly as the README does, `apt-get install pipulse`, and require the installed version to be the new one.

**Renovate (`renovate.json`):**

- Extends `config:recommended`; covers every npm package (dependencies and devDependencies), GitHub Actions (pinned to commit SHAs), the Docker base image (pinned by digest), and `packaging/node-versions.json` through a custom regex manager on the `node-version` datasource.
- `armhf` is held below Node 23; `arm64`/`amd64` follow the current LTS line.
- Every Renovate PR is labelled `release:patch`.
- Patch and minor updates merge automatically once CI passes; majors are opened immediately and wait for review. Security advisories (GitHub's) are raised immediately regardless of schedule.

## One-time GitHub setup

Done by the operator (the plan lists the exact steps):

1. Install the Renovate GitHub App on `seviyon/PiPulse`.
2. Protect `main`: pull requests only, CI required to pass. Allow auto-merge.
3. Create the labels `release:patch`, `release:minor`, `release:major`.
4. Generate the apt signing key (GPG, expiring after a few years, with an offline copy), add its private half and passphrase as repository secrets `APT_SIGNING_KEY` and `APT_SIGNING_PASSPHRASE`.
5. Turn on GitHub Pages from the `gh-pages` branch (created by the first release).

## Security

- Every download is verified: Node by the Node team's GPG signature; release assets by `SHA256SUMS`, itself signed; apt packages by the repository's signed indexes, trusted only for this repository (`signed-by`).
- The apt signing key lives only in GitHub secrets (and the operator's offline copy). A leaked key lets someone publish packages Pis would install; the plan includes how to rotate it (new key, publish its public half, re-add the repository).
- `curl | sudo bash` means trusting what GitHub serves at that moment; the README shows the two-step form for anyone who wants to read the script first.
- The service runs unprivileged with systemd's sandboxing; only `/var/lib/pipulse` is writable.
- Automatic merging is limited to patch and minor updates that pass the full CI, including the packaging tests.

## Testing

- **Unit (Vitest):** `version.json` reading and the `dev` fallback; the end-of-support table (before, after, unknown line); device info with `PIPULSE_HOST_ROOT` pointing at fixture files; plugins marked unavailable in a container and `/api/config` listing them; the tile's "Not available in Docker" text; the Settings About section (with and without the warning); `/api/health` — `200` when healthy, `503` naming the problem when the database fails or no reading was stored for 5 min, public under `PIPULSE_PROTECT_READS`, unaffected by a wall-clock jump; `notifications.stop()` finishing within 5 s and leaving an interrupted row pending with its attempts unchanged.
- **Packaging (CI):** as listed under [CI and release workflows](#ci-and-release-workflows).

## Exit criterion

On `Io` (Pi 2, 32-bit, port 8889 because RPi-Monitor still has 8888), each path from a clean state:

**Before merging** (a tarball built from the branch, copied to the Pi):

1. `sudo sh install.sh --from pipulse-<branch>.tar.gz`. It warns that 8888 is taken; after setting `PIPULSE_PORT=8889`, `PIPULSE_NOTIFY_FILE` and `NODE_EXTRA_CA_CERTS` in `/etc/pipulse/pipulse.env` and restarting, the service runs as `pipulse`.
2. Every tile has readings, including core voltage and throttling. `/api/config` and the Settings About section show the build's version and Node 22 with support until 2027-04-30. `systemd-analyze security pipulse` is recorded.
3. `sudo pipulse notify-test` delivers to Telegram; an alert raised under a `yes` load arrives.
4. After `sudo reboot`, PiPulse is running again and readings continue.
5. Installing a second build keeps the data; installing a deliberately broken build rolls back to the working one on its own.
6. `--uninstall` keeps `/etc/pipulse` and the database; `--purge` removes them and the `pipulse` user.

**After merging** (the first real release, `v0.6.0`):

7. The one-line installer on a cleaned `Io` adds the apt repository and installs `pipulse`; checks 2–4 again.
8. The next release reaches `Io` through `sudo apt upgrade`, keeping the data and `pipulse.env`.
9. `apt remove` keeps data and settings; `apt purge` removes them.

Plus: every CI job green, including the packaging and Docker smoke tests, and the release workflow's own apt install check for `v0.6.0`.

Docker on a real host is **not** part of this criterion: it is checked on the Pi 5 later and recorded as open in `docs/PLAN.md`.
