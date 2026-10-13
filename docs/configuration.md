# Configuration

Settings are environment variables. An installed PiPulse reads them from `/etc/pipulse/pipulse.env`; when you run it from a build, set them in the shell.

| Variable                           | Default             | Purpose                                                                                                                                                  |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIPULSE_DB_PATH`                  | `pipulse.sqlite`    | SQLite database file                                                                                                                                     |
| `PIPULSE_HOST`                     | `0.0.0.0`           | Interface to bind                                                                                                                                        |
| `PIPULSE_PORT`                     | `8889`              | HTTP/WebSocket port (0–65535; empty means 8889, anything else stops the server at startup)                                                               |
| `PIPULSE_WEB_DIR`                  | `packages/web/dist` | Built dashboard to serve at `/` (API-only if missing)                                                                                                    |
| `PIPULSE_ALLOWED_ORIGINS`          | _(none)_            | Extra browser origins allowed on `/api/live`, comma-separated (e.g. behind a reverse proxy)                                                              |
| `PIPULSE_ALLOWED_HOSTS`            | _(none)_            | Host names this server answers to, comma-separated (see below). Unset: any name is served                                                                |
| `PIPULSE_RETENTION_RAW`            | `2d`                | How long raw samples are kept                                                                                                                            |
| `PIPULSE_RETENTION_1M`             | `14d`               | How long 1-minute averages are kept                                                                                                                      |
| `PIPULSE_RETENTION_1H`             | `1y`                | How long hourly averages are kept                                                                                                                        |
| `PIPULSE_RETENTION_1D`             | `forever`           | How long daily averages are kept                                                                                                                         |
| `PIPULSE_ALERTS_FILE`              | _(none)_            | JSON file of alert rules merged over the built-ins (see [Alerts](alerts.md))                                                                             |
| `PIPULSE_ADMIN_PASSWORD_HASH_FILE` | _(none)_            | File with the admin password hash (make one with `hash-password`); unset = read-only (see [Sign-in and settings](configuration.md#sign-in-and-settings)) |
| `PIPULSE_PROTECT_READS`            | `false`             | `true`: every page, API read and the live feed need sign-in                                                                                              |
| `PIPULSE_ALLOW_UPGRADE`            | `false`             | `true`: the Updates tab can install package upgrades (needs sign-in; apt installs and tarball installs only; see below)                                  |
| `PIPULSE_NOTIFY_FILE`              | _(none)_            | JSON file of webhooks to notify when an alert opens or clears (see [Notifications](alerts.md#notifications))                                             |

`PIPULSE_ALLOWED_HOSTS` guards against DNS rebinding on a plain-HTTP install: a web page on a name an attacker controls, pointed at the Pi's address, could otherwise read its public pages from your browser. Set it to the names you reach the Pi by (`io.lan,pi.example`, no ports, schemes or wildcards); a request for any other name gets `421`. Addresses (`http://192.168.1.35:8889`) and `localhost` are always served, and the Pi's own host name, `<host>.local` and `PIPULSE_TLS_NAMES` are added for you. Add the DNS name in your certificate too if it is not one of those, or the health check, which asks for that name, fails. An HTTPS install is already protected by its certificate's names, and a sign-in session cookie is never sent to a rebound name, so changes stay safe either way. An unset or empty value keeps the old behaviour (no check).

Retention values are durations like `36h`, `14d`, `2w`, `1y`, or `forever`; an invalid value stops the server at startup. A minute-by-minute housekeeping job rolls raw samples up into 1-minute, hourly and daily averages (daily on the server's local calendar days) and deletes data past its retention, but only once the next level already covers it. Retention can also be changed on the Settings page, without a restart; a variable that is set wins and locks that field there. Levels must stay in order (raw ≤ 1-minute ≤ hourly ≤ daily); variables out of order stop the server at startup. A longer retention keeps data longer from then on (already-deleted data doesn't come back); a shorter one prunes the excess within a minute. After a large deletion the database compacts itself (at most once a day, only when at least a quarter of an 8 MB+ file is free and the disk has room for about twice the file). The defaults keep the database around 35 MB, sized for an SD card; with faster, larger storage (e.g. NVMe) you can keep much more raw detail.

On a Raspberry Pi, core voltage and throttling come from `vcgencmd`, which only works if the user running PiPulse is in the `video` group (`sudo usermod -aG video <user>`, then restart PiPulse), or, in Docker, if the container gets `--device /dev/vchiq`. Otherwise those two tiles stay on "No readings yet" and the log says why, once for each.

## Sign-in and settings

Without a password PiPulse is read-only: everything shows, nothing can be changed. To enable editing:

```bash
node packages/api/dist/hash-password.js > ~/pipulse-admin.hash   # asks twice, prints one line
chmod 600 ~/pipulse-admin.hash
PIPULSE_ADMIN_PASSWORD_HASH_FILE=~/pipulse-admin.hash node packages/api/dist/server.js
```

Only the scrypt hash is stored; to change the password, make a new file and restart. Sign in on the Settings page; the session lasts 7 days from last use, and a restart signs you out. Five wrong passwords from one address lock it out for 15 minutes.

The Settings page shows each retention level, where its value comes from (default, saved, or locked by a `PIPULSE_RETENTION_*` variable), how much is stored, and the database and disk size. **Review changes** shows what a shorter retention will delete and an estimated database size; deleting anything needs an explicit tick before **Save**. Changes apply within a minute, no restart.

Set `PIPULSE_PROTECT_READS=true` to require sign-in for everything, including the live feed.

## Installing updates from the Updates tab

The Updates tab lists what `apt-get upgrade` would install and shows the command to run over SSH. It can also run it for you, but only if you turn that on:

1. Sign-in must be set up (above).
2. Add `PIPULSE_ALLOW_UPGRADE=true` to `/etc/pipulse/pipulse.env` and `sudo systemctl restart pipulse`.

The tab then shows **Install updates** (signed in, and you type `upgrade` to confirm). PiPulse itself stays unprivileged and cannot run apt. It drops a small request file in its own data folder, and a systemd path unit (`pipulse-upgrade.path`) starts a short root script (`/opt/pipulse/app/packaging/pipulse-upgrade.sh`). The script takes nothing from the request: it reads `PIPULSE_ALLOW_UPGRADE` and the sign-in setting from the root-owned `/etc/pipulse/pipulse.env` itself, ignores the request unless both are set, then runs `apt-get update` and `apt-get -y -o Dpkg::Options::=--force-confold upgrade` (your edited configuration files are kept; nothing is removed; never `full-upgrade`). One upgrade runs at a time. The output is kept (last 200 KB) in `/var/lib/pipulse-updates/upgrade.log`, the result in `upgrade-status.json`, and the tab shows both.

What to know before you use it:

- Sign-in guards the button in the browser. The real gate is `PIPULSE_ALLOW_UPGRADE` in the root-owned `pipulse.env`: if PiPulse's own process were ever taken over, that setting (and `PIPULSE_ADMIN_PASSWORD_HASH_FILE` naming a root-owned file) is all that stands between it and starting an upgrade. The script also waits 10 minutes after one finishes before it accepts another.
- The script runs as root and is not sandboxed (dpkg's package scripts need the whole system), which is why it is off by default. Anyone who can sign in to PiPulse can start a package upgrade; they cannot choose what runs.
- A full upgrade can restart services, including PiPulse and, on a Pi-hole box, `pihole-FTL` (DNS drops for a moment). The tab goes quiet and picks up the result when PiPulse is back. If the machine restarts half way the tab says so; run `sudo dpkg --configure -a` to finish.
- A new kernel or firmware needs a reboot; the tab says when `/run/reboot-required` exists.
- Not available in Docker (the container's apt is not the host's) and not offered when the helper isn't installed.
- The package list and the log are public like the rest of the dashboard unless `PIPULSE_PROTECT_READS=true`.

Over plain HTTP the password crosses the network once at sign-in, so turn on [HTTPS](https.md) or keep it on your LAN; a TLS reverse proxy in front is also possible (see [PLAN.md](PLAN.md), "Future: behind a reverse proxy").

Configuration is environment variables for now (see the table under [Develop](development.md); an installed PiPulse reads them from `/etc/pipulse/pipulse.env`, see [Install](install.md)), plus the alert rules file described under [Alerts](alerts.md) and the webhooks file described under [Notifications](alerts.md#notifications). Retention is editable on the Settings page (see [Sign-in and settings](configuration.md#sign-in-and-settings)); alert rules are editable on the Alerts page (see [Alerts](alerts.md)), signed in. Plugin selection and poll intervals are fixed in code.
