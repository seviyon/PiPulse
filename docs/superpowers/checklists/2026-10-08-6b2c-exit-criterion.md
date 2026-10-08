# 6b-2c exit criterion — operator checklist (Io and a Docker host)

Plan task: Task 27 of `docs/superpowers/plans/2026-09-30-https-6b2.md`. Branch `phase-6b2c-default`.
Covers spec exit criteria 1, 6 (upgrade from 0.6.2), 11 (Docker) and the fresh-install half of 2.
Everything here is manual: it needs the real Pi, its installer prompt and a Docker host.

**Ground rules**

- Pi commands run over SSH as `seviyon@192.168.1.35` (password). Every path is absolute, one command per line.
- Use `io.local` or the IP. **Never `io.lan`** (it resolves to 192.168.1.50 on this LAN).
- Results go in `/Users/seviyon/Repositories/tarballs/PiPulse/6b2c-exit/` (already made). Capture state **before** every purge.
- `--purge` deletes `/etc/pipulse/tls`, so each fresh install makes a **new CA**: trust it on the Mac again (and remove the old "PiPulse CA" entries from the keychain when done).
- Build already done: `/Users/seviyon/Repositories/tarballs/PiPulse/pipulse-0.7.0-rc1.tar.gz`.

---

## 0. Stage the files

- Pi: `mkdir -p /home/seviyon/tarballs/PiPulse`
- Mac: `scp /Users/seviyon/Repositories/tarballs/PiPulse/pipulse-0.7.0-rc1.tar.gz seviyon@192.168.1.35:/home/seviyon/tarballs/PiPulse/`
- Mac: `scp /Users/seviyon/Repositories/PiPulse/packaging/install.sh seviyon@192.168.1.35:/home/seviyon/tarballs/PiPulse/`
- Pi, save the current state first: `sudo pipulse tls status` and `curl -k https://io.local:8889/api/health` → `/Users/seviyon/Repositories/tarballs/PiPulse/6b2c-exit/00-before.txt` (copy by hand).

## 1. Upgrade from 0.6.2 stays on HTTP (criterion 6)

- Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --purge`
- Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --version 0.6.2` → `running 0.6.2`, `http://io.local:8889`.
- Pi: `pipulse hash-password | sudo tee /etc/pipulse/admin.hash` (README, "Sign-in and settings"), set `PIPULSE_ADMIN_PASSWORD_HASH_FILE=/etc/pipulse/admin.hash` in `/etc/pipulse/pipulse.env`, `sudo systemctl restart pipulse`, sign in, let it collect ~5 min.
- Mac, save: `curl http://io.local:8889/api/health` → `01-health-0.6.2.json`.
- Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --from /home/seviyon/tarballs/PiPulse/pipulse-0.7.0-rc1.tar.gz`
- **Expect:**
  - `running 0.7.0-rc1`, **no prompt** (it is an upgrade), still `http://`.
  - Install output and `journalctl -u pipulse -n 50` both say `HTTPS is ready but not switched on (this is an upgrade): sudo pipulse tls enable`.
  - Settings shows the HTTP banner; sign-in still works; the data from 0.6.2 is still there (History).
  - `sudo pipulse tls status` → `legacy-http`, a names-only CA prepared. Save → `02-status-upgrade.txt`.
  - `curl http://io.local:8889/api/health` still answers over HTTP.
- Pi: `sudo pipulse tls enable` → verified HTTPS. Mac: `sudo pipulse tls export-ca` fingerprint vs. Mac's `openssl x509 -fingerprint -sha256` on the exported file, trust the CA (as in 6b-2a Task 13), load `https://io.local:8889` Live. `sudo pipulse tls status` → `03-status-enabled.txt`.
- Pi: `sudo pipulse tls disable --allow-insecure` → HTTP again, dashboard Live over `ws://`.
- Pi: `sudo pipulse tls enable` once more, leave it on HTTPS.

## 2. Reinstall over kept data (marker rule)

- Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --uninstall` (keeps `/etc/pipulse` and the database).
- Pi: `sudo rm -rf /etc/pipulse/tls`
- Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --from /home/seviyon/tarballs/PiPulse/pipulse-0.7.0-rc1.tar.gz`
- **Expect (last commit, `3019ea8`):** the data was served over HTTPS (the `tls-installed` marker) and its TLS folder is gone, so the installer must **not** fall back to HTTP behind your back. Either `init --mode auto` recreates the CA and HTTPS comes back, or it warns "PiPulse will not start until you run: sudo pipulse tls init --mode auto". Record which → `04-lost-tls.txt`. If it stopped: `sudo pipulse tls init --mode auto`, restart, trust the new CA.

## 3. Fresh install with the prompt (criteria 1 and 2)

Run from an **interactive** session: `ssh -t seviyon@192.168.1.35`.

- Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --purge`
- Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --from /home/seviyon/tarballs/PiPulse/pipulse-0.7.0-rc1.tar.gz`
- **Expect:**
  - The prompt offers `192.168.1.0/24` with the explanation about a stolen CA key. Answer **Enter** (No) → "names only; to add it later: sudo pipulse tls new-ca --subnet 192.168.1.0/24".
  - The CA fingerprint and names-only scope are printed; `running 0.7.0-rc1` over HTTPS with no manual step.
  - Mac: compare fingerprints, trust the new CA, `https://io.local:8889` loads Live; `https://192.168.1.35:8889` warns (names only).
  - `sudo ls -l /var/lib/pipulse/tls-installed` exists.
  - Save install output → `05-fresh-install.txt`, `sudo pipulse tls status` → `06-status-fresh.txt`.
- Repeat once answering **y** to the prompt (purge first): IP URL loads without a warning; `status` shows the subnet. Save → `07-fresh-subnet.txt`.
- Unattended: `ssh seviyon@192.168.1.35 sudo sh /home/seviyon/tarballs/PiPulse/install.sh --purge`, then the same install **without** `-t` → no prompt, names only, still HTTPS.
- `PIPULSE_TLS=off`: `--purge`, then `export PIPULSE_TLS=off` and install with `sudo -E` → no CA made, `state.json` is `legacy-http`, HTTP serves. Save → `08-tls-off.txt`. Then `--purge` and reinstall as the normal fresh install to leave Io on HTTPS.

## 4. Docker (criterion 11) — Mac with Colima, 64-bit

- Mac: `colima status` (start it if needed).
- Mac: `cd /Users/seviyon/Repositories/PiPulse && docker build -t pipulse:test .`
- Mac: `sh /Users/seviyon/Repositories/PiPulse/packaging/test/compose.sh pipulse:test` → all 20 checks `ok`. Save → `09-compose-test.txt`.
- By hand, in `/Users/seviyon/Repositories/tarballs/PiPulse/6b2c-docker/`: copy `/Users/seviyon/Repositories/PiPulse/compose.yaml` there; set the image to `pipulse:test`; remove the Pi-only host mounts (the `/etc/hostname` and `/dev/vchiq` entries) and either remove the `/run/systemd/timesync` mount or set `PIPULSE_TLS_CLOCK=trust` (a Colima VM has no timesyncd folder).
  - `docker compose up -d`
  - `docker compose ps` → init exited 0, `pipulse-tls` healthy, `pipulse` healthy.
  - `docker compose logs pipulse-tls` → fingerprint and scope.
  - `docker compose exec pipulse pipulse tls status`
  - `docker compose exec pipulse pipulse tls export-ca > ca.crt`
  - `colima ssh` then, from the shared folder: `curl --cacert ca.crt https://localhost:8889/api/health` → `200`.
  - Server cannot see the CA key: `docker compose exec pipulse ls /tls-ca` fails (no such directory); `docker compose exec pipulse touch /tls/x` fails (read-only).
  - `docker compose down -v` when done.
  - Save outputs → `10-docker.txt`.

## 5. After you are done

- Leave Io on 0.7.0-rc1 over HTTPS (default fresh install), trusted CA on the Mac.
- Tell me the results (or paste the files). I then update `CLAUDE.md` (6b-2c done, v0.7.0 on merge), push the branch and open the PR with `release:minor`.
- **After the release** (not now): `curl -fsSL https://github.com/seviyon/PiPulse/releases/latest/download/install.sh | sudo sh` on a purged Io asks the same prompt through `/dev/tty`, and apt passes `PIPULSE_TLS_INIT_SUBNET` to `postinst` (answer y and check the subnet landed in `status`).
