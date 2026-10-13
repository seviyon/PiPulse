# HTTPS

A fresh install serves HTTPS from a certificate made for the Pi (below). You can instead serve HTTPS with your own certificate (from a homelab CA, or a public one):

## Your own certificate

1. Put the certificate (with its chain, leaf first) and its unencrypted key in `/etc/pipulse/`: `sudo chown root:pipulse …; sudo chmod 640 <key>` (the key must not be readable by everyone).
2. In `/etc/pipulse/pipulse.env` set `PIPULSE_TLS=on`, `PIPULSE_TLS_CERT=…`, `PIPULSE_TLS_KEY=…`, and — for a private CA — `PIPULSE_TLS_CA=…`.
   With Let's Encrypt's certbot, note that `live/` and `archive/` are `0700 root` and the private key is `0600`, so the pipulse user can't read them in place. Either give the `pipulse` group read access, or copy with a deploy hook (the reload picks the copy up):

   ```sh
   # /etc/letsencrypt/renewal-hooks/deploy/pipulse
   #!/bin/sh
   install -m 644 -o root -g pipulse "$RENEWED_LINEAGE/fullchain.pem" /etc/pipulse/cert.pem
   install -m 640 -o root -g pipulse "$RENEWED_LINEAGE/privkey.pem" /etc/pipulse/key.pem
   ```

3. `sudo systemctl restart pipulse`, then open `https://<pi>:8889`. The old `http://` address stops answering (there is no redirect).

A chain that a browser would refuse for its CA's limits is flagged too: a CA above the certificate that restricts the path length or the names it may certify (name constraints) and is broken by this chain shows as untrusted, with `path-length` or `name-constraint` in the startup warning and Settings → Certificate. It is a warning, not a refusal: PiPulse still serves it.

Replacing the files later (e.g. a renewal) is picked up within about two minutes without a restart; a replacement that is broken or worse than the current one is ignored, and Settings → Certificate says why. A broken certificate or key stops PiPulse from starting, with one line in `journalctl -u pipulse` naming the setting (for example `PIPULSE_TLS_CERT/PIPULSE_TLS_KEY: …` or `PIPULSE_TLS_CA: certificate 1 can't be parsed`); an expired one only warns (monitoring continues — but browsers will refuse the page). Expiry counts for the whole chain: an expired intermediate in `fullchain.pem` makes the certificate expired even if the leaf is not. `PIPULSE_TLS_REQUIRE_VALID_CERT=true` refuses expired ones instead. A replacement that is refused only because of its dates (not valid yet, say) is tried again every 10 minutes, so it goes live once it is valid.

Names you list in `PIPULSE_TLS_NAMES` are checked against the certificate's subject alternative names only (the common name is never used), so a certificate that names a host only in its CN shows a warning in Settings. A chain that doesn't reach a CA you configured, or a self-signed one nobody configured, also starts with a warning rather than a refusal.

## The installer's health check

connects to `PIPULSE_HOST` and verifies the certificate for exactly that address or name. When PiPulse listens everywhere (`0.0.0.0` or `::`) it connects to this Pi over loopback and verifies the certificate for the first `PIPULSE_TLS_NAMES` entry, else `localhost` if the certificate lists it, else `127.0.0.1` if it lists that, else its first non-loopback IP SAN, then its first plain DNS SAN. A certificate that names only a wildcard (`*.example.com`) is probed as `pipulse.example.com`; if `PIPULSE_ALLOWED_HOSTS` is set the server answers that name with `421`, and the fix is to set `PIPULSE_TLS_NAMES` to a name the certificate covers. When `PIPULSE_TLS_CA` is set it is the only trust anchor for the check (it replaces Node's roots); without it the check trusts Node's bundled Mozilla roots, not `/etc/ssl/certs`, so a CA added with `update-ca-certificates` is not trusted. It never uses a proxy (`HTTP_PROXY`, `NODE_USE_ENV_PROXY`) and never trusts `NODE_EXTRA_CA_CERTS`, in Docker too (that variable only helps PiPulse's own webhook deliveries); a private CA must therefore be set as `PIPULSE_TLS_CA`. If verification fails, the installer says so and does not roll back, because the previous version would serve the same certificate. Docker's health check runs inside the container and sees the same environment as the server.

## HSTS is off by default

Browsers apply it to every port of a host name, so turning it on (`PIPULSE_TLS_HSTS=1d`) would also force HTTPS for Pi-hole's admin page or RPi-Monitor on the same Pi. Turn it on only when nothing else on that name speaks plain HTTP.

If the Pi uses chrony or ntpd instead of systemd-timesyncd, set `PIPULSE_TLS_CLOCK=trust` so certificate decisions trust its clock. Until the clock is trusted, a certificate that looks not yet valid never stops PiPulse from starting, even with `PIPULSE_TLS_REQUIRE_VALID_CERT=true`, so a reboot without an RTC cannot keep HTTPS down.

**Docker:** mount the files read-only (e.g. into `./config`) and set the same variables in `pipulse.env`.

## A certificate made on the Pi

The default on a fresh install from 0.7.0. PiPulse makes a certificate authority (CA) for this Pi and a certificate from it. A fresh install does this and starts on HTTPS; the installer prints the CA fingerprint and the names it covers. On an **upgrade** nothing changes by itself: the CA is prepared, the server stays on HTTP, and `sudo pipulse tls enable` switches. `sudo pipulse tls disable --allow-insecure` goes back to HTTP (the certificates stay). If you go back to a release older than 6b, it ignores `/etc/pipulse/tls` and serves plain HTTP. If the installer is run at a terminal on a fresh install it asks whether to also cover the LAN's IP range (default No; see below). Anything unattended covers names only.

```bash
sudo pipulse tls init                 # makes the CA and certificate; prints the CA fingerprint and what it covers
sudo pipulse tls status               # the same fingerprint, again: run it over SSH or at the Pi's console
sudo pipulse tls export-ca --out /home/<you>/pipulse-ca.crt   # then scp it to each device
sudo pipulse tls enable               # serve HTTPS (checks it works, else goes back on its own)
sudo pipulse tls disable --allow-insecure   # serve plain HTTP again; the certificates stay
```

1. **Check the fingerprint before you trust anything.** The installer printed it on a fresh install; it is the same every time. Compare the one `export-ca` prints with the one `sudo pipulse tls status` shows on the Pi itself, over a channel you already trust (SSH, the console), never with one a web page shows.
2. **Trust the certificate authority** (not a single certificate) on each device. Say "trust this certificate authority", never "accept this certificate": the browser's warning page offers the second, which only covers one visit. `export-ca` prints the steps: on macOS `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain pipulse-ca.crt`; Windows, Linux and phones have their own certificate stores. **Firefox** ignores the macOS keychain unless `security.enterprise_roots.enabled` is `true` in `about:config`.
3. On a fresh install HTTPS is already on; after an upgrade run `sudo pipulse tls enable`. Then open `https://<pi>:8889`. Old `http://` bookmarks stop answering (they get a hint page; see below). If HTTPS does not come up healthy, `enable` puts the previous mode back by itself. If the command itself is ever killed half-way, `sudo pipulse tls disable --yes` (or deleting `/etc/pipulse/tls/state.json`) returns to the previous behaviour.

## What the CA may cover

It is name-constrained: it can only vouch for this Pi's host name, `<host>.local`, `localhost`, any `PIPULSE_TLS_NAMES` you list, and the IP ranges you accept. By default it covers no LAN IP range, so `https://192.168.1.35:8889` shows a warning; to cover it, accept the range explicitly: `sudo pipulse tls init --subnet 192.168.1.0/24` (or, to change a CA that exists, `sudo pipulse tls new-ca --subnet …`). Accepting a range lets a stolen CA key impersonate any device in it, and `init` says so before it asks. Extra names must be dotted (`pi.local`, not `pi`): a single-label name would let the CA vouch for everything below it, so only the host's own name and `localhost` may be single-label. `new-ca` keeps the current ranges unless you say otherwise (`--subnet none` drops them).

> The CA also excludes every name _below_ a single-label name it covers (for a Pi called `io`, anything ending in `.io`), so a stolen CA key still could not vouch for `evil.io` or any other site under a top-level domain that matches your host name. Safari, Chrome and Firefox were checked to load `https://io` and refuse `https://x.io` under such a CA.

## Renewal

A timer (`pipulse-tls-renew.timer`) checks every hour and renews the 90-day certificate 30 days before it ends. It waits until the clock is synchronized (a Pi has no clock of its own), and also renews early when this Pi gets a new address inside an accepted range (a new IPv6 address waits a day, because privacy addresses rotate). `sudo pipulse tls status` shows the last result. A `new-ca` left waiting at its confirmation prompt holds the lock, so the hourly renewal fails (and says so) until you answer it. The timer is enabled once, on the first install or the first upgrade that has it; after that `systemctl disable` and `systemctl mask pipulse-tls-renew.timer` are yours (a masked timer is left alone, with a warning, and renewals stop).

## Backups

`/etc/pipulse/tls` is a secret: it holds the CA key. Back it up like one, and never copy `ca/` to a device. `new-ca` keeps the old CA as `ca.old-<time>`, at most two (a third change needs `--prune-oldest <oldest>`), and `sudo pipulse tls restore-ca ca.old-<time>` brings one back. On a Pi install generated certificates live only in `/etc/pipulse/tls`: a custom `PIPULSE_TLS_DIR` is refused for them, because the renewal service's sandbox can write nowhere else (your own certificate can live anywhere).

## Recovering the CA

An unfinished CA change (a crash or power loss while it ran) is finished or rolled back by the next command that changes something (`init`, `renew`, `new-ca`, `restore-ca`, `enable` or `disable`); nothing else is needed. `status` and `export-ca` only read: they leave it unfinished, and `status` says when one is pending. An incomplete `ca/` folder is never regenerated: restore a backup, or move `ca/` aside and run `sudo pipulse tls init`, after which every device must trust the new CA.

## Seeing what is happening

`sudo pipulse tls status` shows, next to what is configured on disk, what the running server actually serves (`Active … HTTPS, pid …, serving SHA-256 …`), and says when a newer certificate on disk was not applied and why. The server publishes this in `/run/pipulse/tls-status.json`; `status` treats that file as untrusted input and prints only validated values. A failing renewal shows on Settings → Certificate ("Renewal failing: …"), in `/api/health` (`degraded`, reason `renewal-failing`) and in `pipulse tls status`; the current certificate keeps serving until it expires. Settings also shows the CA fingerprint (compare it with `sudo pipulse tls status` on the Pi, never with this page alone), what the certificate covers, whether a warning is expected for the address you opened, and refreshes by itself every minute.

## Certificate alerts

With HTTPS on, two built-in rules watch the served certificate: `cert_expiring` (warning, 14 days before it ends) and `cert_expired` (critical). They go through the usual alert path, so the Alerts page, the nav badge and your webhooks all see them. While the clock is not synchronized they stay undecided: a Pi without a clock would otherwise raise a false expiry after every boot.

## Old `http://` bookmarks

A browser that opens `http://<pi>:8889` while HTTPS is on gets a small page saying to use `https://`, instead of a dropped connection. It is a fixed page: nothing from the request is read or echoed, and there is no redirect. It relies on an undocumented Node detail, so if a future Node drops it the connection is simply closed, as before; requests of hundreds of KB (never a browser's) can lose the page to a connection reset.

## Three things to know

- **An expired certificate locks browsers out while monitoring continues.** PiPulse keeps collecting, alerting and notifying; only the page is refused. Renewal is automatic, `cert_expiring` warns 14 days ahead, and the Alerts page and your webhooks show `cert_expired`. On a Pi that was off for a long time, renewal waits for the clock to synchronize.
- **HSTS ignores ports.** It stays off unless you set `PIPULSE_TLS_HSTS`; see above.
- **The CA key is a secret, and `/etc/pipulse/tls` is this Pi's trust identity.** Every device trusts the CA there. Back the folder up like a secret; if it is lost, a new CA means trusting it again on every device.
