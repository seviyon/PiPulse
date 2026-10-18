# Updates tab: design

Status: requested 2026-10-13. Two pieces, built as two PRs: **A** (read-only tab) and **B** (opt-in upgrade button). A ships useful on its own and adds no privilege. B is a root action triggered from a browser and gets its own review.

## Goal

A new **Updates** page in the dashboard that says, in words:

- whether a newer PiPulse release is available and how to install it,
- which operating-system packages `apt-get upgrade` would install (and which it would keep back),
- how fresh that information is,

with a badge on the tab when something is waiting. Optionally (piece B, off by default), a button that runs `apt-get update && apt-get upgrade` on the Pi.

## Where the information comes from

The server runs the simulation itself, as the unprivileged `pipulse` user, with no network and no lock:

- `/usr/bin/apt-get -s -o Debug::NoLocking=1 upgrade` (the same operation the button would run). `Inst name [old] (new repo)` lines are the packages; `The following packages have been kept back:` lists the held ones.
- `/usr/bin/apt-cache policy pipulse`: `Installed` and `Candidate` for PiPulse itself. No `Installed` (or no apt package) means a tarball install.
- When apt last ran a refresh: the newer of the mtime of `/var/lib/apt/periodic/update-stamp` (written by Debian's `apt.systemd.daily` after an `apt-get update` that exits 0; `update-success-stamp` is Ubuntu's, from `update-notifier-common`, and Debian has none) and of the folder `/var/lib/apt/lists/partial`, which every `apt-get update` touches. This is when apt ran, **not proof that it reached a repository**: `apt-get update` exits 0 with `W: Failed to fetch` when offline (apt 2.2.4 and 2.6.1, tested in Debian containers with no network) and both files move anyway, so an offline Pi looks freshly refreshed. The tab says so. The list files' own mtimes are not used: apt sets them to the server's Last-Modified, so they say when a repository last changed (checked on `Io`, 2026-10-18). A real check would need a non-root `apt-get update` into a private lists directory with the package indexes off (`Acquire::IndexTargets::deb::Packages::DefaultEnabled=false`, so only the small `InRelease` files are fetched): not built. Older than two days: the tab says to run `sudo apt-get update`.

Both commands are run by absolute path with a fixed argv, `LC_ALL=C`, a minimal environment, a timeout of 2 minutes and `SIGKILL`, and their output is capped. Nothing is run when `PIPULSE_IN_CONTAINER=true` (the container's apt is not the host's) or when `/usr/bin/apt-get` is missing: the tab then says "not available here" and, in Docker, how to update the image (`docker compose pull && docker compose up -d`).

First check two minutes after start (so boot is not slowed), then every 6 hours on a monotonic timer, and on demand (`POST /api/updates/check`, signed in, at most one per 30 s). The result lives in memory only; a restart checks again.

The simulation reads the package lists as they are. Refreshing them is `apt-daily.timer`'s job (it refreshes when `APT::Periodic::Update-Package-Lists` is `1`, as on `Io`), or the button's (piece B, not built: the tab only reads what apt already refreshed, so nothing runs as root).

## API

- `GET /api/updates` → one of
  - `{ "state": "unsupported", "reason": "container" | "no-apt" }`
  - `{ "state": "pending" }` (the first check has not run)
  - `{ "state": "failed", "checkedAt", "problem" }` (one line, no paths)
  - `{ "state": "ok", "checkedAt", "listsRefreshedAt" | null, "pipulse": { "source": "apt" | "other", "installed", "candidate", "available" }, "os": { "total", "packages": [{ "name", "from", "to" }], "keptBack": [] } }`, at most 300 packages listed (`total` is exact).
- `POST /api/updates/check` → the same body after a fresh check. A write: it needs a session (and a same-host Origin) like every other write, never an unauthenticated trigger.

Reads follow `PIPULSE_PROTECT_READS` like the rest of the API. The package list tells an attacker which packages are out of date; the Settings and About pages already say which PiPulse and Node versions run. Set `PIPULSE_PROTECT_READS=true` to hide it.

## Dashboard

- Route `#/updates`, tab **Updates** after Alerts, with a count badge (PiPulse update counts as one, plus OS packages) when something is waiting. The badge is fetched at load and every 10 minutes, and never raises an alert.
- Sections: **PiPulse** (installed → available; the command for this install type: `sudo apt-get update && sudo apt-get install --only-upgrade pipulse` for apt installs, re-run the installer for tarballs, `docker compose pull && docker compose up -d` in Docker), **System packages** (table name / from / to, the kept-back list), **When** (checked, apt's last refresh).
- The full command `sudo apt-get update && sudo apt-get upgrade` is shown with a **Copy** button, always.
- **Check now** when signed in.
- Everything is stated in words; status is never colour alone.

## Piece B: the opt-in upgrade button

Off unless `PIPULSE_ALLOW_UPGRADE=true` is set in `pipulse.env` **and** sign-in is configured. The server is unprivileged and its unit forbids privilege, so it cannot run apt. The design keeps it that way:

1. `POST /api/updates/upgrade` (session, same-host Origin, a typed confirmation in the body) writes one small request file, `/var/lib/pipulse/upgrade-request`, and returns `202`.
2. A systemd **path unit** (`pipulse-upgrade.path`, `PathExists=`) starts `pipulse-upgrade.service`, a root oneshot. The request file is only a doorbell: the helper reads `PIPULSE_ALLOW_UPGRADE` from `/etc/pipulse/pipulse.env` (root-owned) itself, ignores the request when it is not `true`, deletes the request first, and checks it (regular file, owned by `pipulse`, at most 1 KB, written in the last 2 minutes). A compromised web process can ring the bell only on an install whose operator turned the feature on.
3. The helper takes a `flock`, runs `apt-get update` then `apt-get -y -o Dpkg::Options::=--force-confold upgrade` with `DEBIAN_FRONTEND=noninteractive` and no other input, appends the output to `/var/lib/pipulse-updates/upgrade.log` (root-owned, world-readable, last 200 KB) and writes `upgrade-status.json` (`running`, `done`, `failed`, times, exit code) atomically. It takes no parameter from the request.
4. The tab shows the status and the log tail; a page that loses its connection because the upgrade restarted PiPulse reconnects and shows the result.

What this does not protect against, and says so on the page: a full upgrade can restart services (`pipulse`, and `pihole-FTL` on `Io`), replace the kernel (reboot needed) and break a package set. The button is for someone who accepts that; the command line stays the way for everyone else. The helper unit cannot be sandboxed (dpkg maintainer scripts need the whole system), which is why it is opt-in, root-only, parameterless and gated on root-owned configuration.

## Not in scope

Automatic upgrades, scheduling, `dist-upgrade`/`full-upgrade`, removing packages, upgrading in Docker, updating firmware, notifications about pending updates (an alert rule could be added later), and a changelog viewer.

## Tests

Pure parsers (`Inst`, kept-back, policy output, lists age) with real apt output captured from Debian bookworm and Raspberry Pi OS; the checker with an injected runner (timeouts, killed output, output caps, container, no apt, failure, refresh limit); routes (read, protected read, check requires a session); web (tab, badge, command and Copy, states in words); e2e (the tab with fake data). Piece B: the helper in a systemd container (an upgrade of a fake package, the ignored request when disabled, concurrency, status file).
