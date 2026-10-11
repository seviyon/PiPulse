# Install

How to install, upgrade and remove PiPulse on a Raspberry Pi or any Debian-based Linux. For HTTPS see [HTTPS](https.md); for Docker see [Docker](docker.md).

On a Raspberry Pi (or any Debian-based Linux) — Pi 2 and newer, 32- or 64-bit:

```bash
curl -fsSL https://github.com/seviyon/PiPulse/releases/latest/download/install.sh | sudo sh
```

That adds PiPulse's signed apt repository and installs the `pipulse` package, which carries its own Node.js (the system's is left alone). It runs as the `pipulse` service on port **8889** (next to RPi-Monitor, which uses 8888); open `https://<pi>:8889/` once you have trusted its certificate authority (see [HTTPS](https.md); an install that was already running keeps `http://` until you switch). New releases then arrive with `sudo apt upgrade`. Running the one-liner again is safe: it installs any newer version. If the repository can't be reached, nothing changes. If an upgrade fails, PiPulse stays installed and its apt source is kept, but the new version is left half-configured until you run `sudo apt-get -f install` (the installer says so). Prefer to read the script first? Download it, read it, then run it:

```bash
curl -fsSLO https://github.com/seviyon/PiPulse/releases/latest/download/install.sh
less install.sh
sudo sh install.sh
```

The installer carries the repository's public signing key inside it (fingerprint `8D7C 444E F948 DB10 BF46 F1D7 DC0C DCCD B605 4E4A`) and trusts that, not a key downloaded from the apt site; a `--tarball` / `--version` install verifies the release's `SHA256SUMS.asc` with it before it unpacks anything. So it matters where `install.sh` comes from: take it from the GitHub release, as above.

Or add the repository by hand:

```bash
curl -fsSL https://seviyon.github.io/PiPulse/apt/pipulse.gpg | sudo tee /usr/share/keyrings/pipulse.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/pipulse.gpg] https://seviyon.github.io/PiPulse/apt stable main" | sudo tee /etc/apt/sources.list.d/pipulse.list
sudo apt update && sudo apt install pipulse
```

**Settings** live in `/etc/pipulse/pipulse.env` (every variable is listed there, commented out, with its default); files it points at — a password hash, a rules file, a notify file, a CA certificate — go in `/etc/pipulse/` too (`root:pipulse`, mode `640`). After a change: `sudo systemctl restart pipulse`. The database is `/var/lib/pipulse/pipulse.sqlite`. The installer warns, without changing anything, when the port is already taken or ufw would block it.

**HTTPS by default (0.7.0 and later).** A fresh install serves HTTPS on port 8889 from a certificate authority (CA) made for this Pi; the installer prints the CA's fingerprint and what it covers, and you trust that CA once on each device (see [HTTPS](https.md)). An **upgrade stays on plain HTTP** until you run `sudo pipulse tls enable`, so an existing bookmark and any monitor keep working; Settings shows a banner until then. Plain HTTP means that on a network others can watch (shared Wi-Fi, a guest VLAN) the sign-in password and the session cookie can be captured: keep it on a network you trust, set `PIPULSE_HOST` to a single interface if that helps, and don't expose its port to the internet. `PIPULSE_TLS=off` in `pipulse.env` forces plain HTTP whatever else is set.

The `pipulse` command wraps the everyday tasks, with the service's settings loaded:

```bash
pipulse version                               # PiPulse and Node versions, and Node's end of support
pipulse hash-password | sudo tee /etc/pipulse/admin.hash >/dev/null
sudo chown root:pipulse /etc/pipulse/admin.hash && sudo chmod 640 /etc/pipulse/admin.hash
sudo pipulse notify-test [webhook-id]         # send a test message through PIPULSE_NOTIFY_FILE
sudo pipulse tls status                       # the generated certificate: fingerprint, scope, renewal (see HTTPS)
```

**Remove:** `sudo apt remove pipulse` keeps your settings and data; `sudo apt purge pipulse` deletes them.

**Without apt** (or to try a build before it's released), install from the release tarball instead. It checks the download, installs the same way, and rolls back on its own if an upgrade doesn't come up healthy:

```bash
curl -fsSL https://github.com/seviyon/PiPulse/releases/latest/download/install.sh | sudo sh -s -- --tarball
sudo sh install.sh --version 0.6.1              # a specific release
sudo sh install.sh --from pipulse-0.6.1.tar.gz  # a local file
sudo sh install.sh --uninstall                  # keeps /etc/pipulse and the data; --purge removes them
```

**Node.js support.** Each install carries its own Node: 22 LTS on 32-bit Pis (the last Node line built for 32-bit ARM) and 24 LTS on 64-bit. Node security fixes reach you through normal PiPulse releases. Node 22's security support ends on **30 April 2027**; after that a 32-bit Pi keeps working on an unpatched Node, and the Settings page and the startup log say so. Moving PiPulse to a 64-bit Pi is the long-term fix. The Pi 1 and Pi Zero (`armv6`) aren't supported.
