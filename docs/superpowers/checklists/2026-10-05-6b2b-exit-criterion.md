# 6b-2b exit criterion on `Io` — operator checklist

Plan task: Task 20 of `docs/superpowers/plans/2026-09-30-https-6b2.md`. Branch `phase-6b2b-visibility` (stacked on 6b-2a).
Everything here is manual: it needs the real Pi, its systemd unit and real browsers.

**Ground rules** (same as the 6b-2a checklist)

- Pi commands run over SSH as `seviyon@192.168.1.35` (password). Every path is absolute, one command per line.
- Use `io.local` or the IP. **Never `io.lan`** (it resolves to 192.168.1.50 on this LAN).
- Keep results in `/Users/seviyon/Repositories/tarballs/PiPulse/6b2b-exit/` (make it first). Capture state **before** anything is deleted (step 8).
- Io is expected on `0.6.4-rc1`, HTTPS, CA B generated, A as backup, both trusted on the Mac. Check with `sudo pipulse tls status` first.

---

1. **Build and install** (Mac, then Pi), as in 6b-2a Part 1 step 2–3 with `0.6.5-rc1`:
   - `cd /Users/seviyon/Repositories/PiPulse && npm run build`
   - `sh /Users/seviyon/Repositories/PiPulse/packaging/build-tarball.sh 0.6.5-rc1 /Users/seviyon/Repositories/tarballs/PiPulse`
   - `scp /Users/seviyon/Repositories/tarballs/PiPulse/pipulse-0.6.5-rc1.tar.gz seviyon@192.168.1.35:/home/seviyon/tarballs/PiPulse/`
   - `scp /Users/seviyon/Repositories/PiPulse/packaging/install.sh seviyon@192.168.1.35:/home/seviyon/tarballs/PiPulse/`
   - Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --from /home/seviyon/tarballs/PiPulse/pipulse-0.6.5-rc1.tar.gz`
   - If Io is on HTTP: `sudo pipulse tls enable --yes`.
   - Record: `running 0.6.5-rc1`, and the mode.

2. **Status channel.**
   - Pi: `sudo pipulse tls status` → `Active (the running server)` shows `HTTPS, pid …, serving SHA-256 …` and the fingerprint **matches the configured leaf**.
   - Pi: `sudo ls -l /run/pipulse/tls-status.json` → owner `pipulse`, mode `0640`.
   - Pi: `sudo systemctl stop pipulse`, then `sudo pipulse tls status` → `not running (missing)`. Then `sudo systemctl start pipulse`.
   - Record: both outputs.

3. **A failing renewal (criterion 8).**
   - Pi: `sudo chattr +i /etc/pipulse/tls/leaf.pem`
   - Force a renewal through the real unit:
     ```
     sudo mkdir -p /etc/systemd/system/pipulse-tls-renew.service.d
     printf '[Service]\nExecStart=\nExecStart=/usr/bin/pipulse tls renew --force\n' | sudo tee /etc/systemd/system/pipulse-tls-renew.service.d/force.conf
     sudo systemctl daemon-reload && sudo systemctl start pipulse-tls-renew.service
     sudo cat /etc/pipulse/tls/renew-status.json
     ```
   - Expect: `renew-status.json` says `failed`; `sudo pipulse tls status` shows `Last renewal … FAILED`; Settings (Certificate) shows "Renewal failing: …" within a minute; `curl --cacert /Users/seviyon/pipulse-ca.crt https://io.local:8889/api/health` is `200` with `"status":"degraded"` and `renewal-failing` in `reasons`; the dashboard stays Live.
   - Then: `sudo chattr -i /etc/pipulse/tls/leaf.pem`, run `sudo systemctl start pipulse-tls-renew.service` again.
   - Expect: `renewed`; health back to `ok`; **the open Settings tab updates by itself within a minute, no reload**.
   - Clean up: `sudo rm -r /etc/systemd/system/pipulse-tls-renew.service.d && sudo systemctl daemon-reload`.
   - Record: the three `renew-status.json` / health bodies and whether the tab refreshed itself.

4. **Certificate alerts to Telegram (criterion 9).** Needs the Apprise webhook and `NODE_EXTRA_CA_CERTS` for the homelab CA, as in 5b-3.
   - Mac: make a throwaway CA and a leaf for `io`, `io.local` and `192.168.1.35` that expires **20 minutes from now** (`openssl ca -startdate <now> -enddate <now+20min>`, as in `packages/tls/test/fixtures/make-fixtures.sh`; the 14-day rule is then already inside its window).
   - `scp` the cert, key and CA to the Pi with absolute paths; `/etc/pipulse/`, `root:pipulse`, key `640`.
   - In `/etc/pipulse/pipulse.env` set `PIPULSE_TLS=on`, `PIPULSE_TLS_CERT`, `PIPULSE_TLS_KEY`, `PIPULSE_TLS_CA`, `PIPULSE_NOTIFY_FILE`, and `NODE_EXTRA_CA_CERTS`; `sudo systemctl restart pipulse`.
   - Expect: within about 15 s `cert_expiring` opens (Alerts page and badge) and Telegram gets "raised". At expiry, one check clears `cert_expiring` and opens `cert_expired`; Telegram gets them **in that order**.
   - Capture before restoring: `curl -k https://io.local:8889/api/alerts?state=all` (`-k` only because it has expired by now) and the outbox:
     ```
     sudo -u pipulse /opt/pipulse/node/bin/node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/pipulse/pipulse.sqlite',{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT * FROM notifications ORDER BY id').all(),null,1))"
     ```
   - Then restore the generated certificate: remove the operator lines from `pipulse.env`, `sudo systemctl restart pipulse`.
   - Record: both alert JSONs, the outbox, and the order of the Telegram messages.

5. **Hint page.** In Safari and Firefox (Chrome too if you can) open `http://io.local:8889` (and the IP form).
   - Expect: a small page "PiPulse uses HTTPS", not "Unable to connect". Note any browser that shows a connection error instead.
   - Pi: `curl -si http://io.local:8889/` shows `HTTP/1.1 400 Bad Request` with the fixed body.

6. **CA change seen from Settings.** Keep a Settings tab open.
   - Pi: `sudo pipulse tls new-ca --yes`.
   - Expect, until the reload (about two minutes): the tab says "The CA is being replaced; the served certificate has not switched yet" and shows no scope; `curl --cacert … /api/health` shows `"metadata":"transitional"` with status `ok`. After the reload the new scope shows.
   - Pi: `sudo chmod 000 /etc/pipulse/tls/ca-meta.json`. Expect health `degraded` with `generated-metadata-unreadable`, and Settings "CA details unavailable: ca-meta.json: EACCES".
   - Restore: `sudo chmod 644 /etc/pipulse/tls/ca-meta.json` (or `sudo pipulse tls renew`). Use `restore-ca` if you want the previous CA back, and trust the new one on the Mac if you keep it.
   - Record: what the tab showed at each point.

7. **Settings coverage and year.**
   - With a names-only CA: `https://io.local:8889` → Settings shows "Certificate warning expected here: no …"; `https://192.168.1.35:8889` (accept the warning) shows "yes (192.168.1.35 is not in the certificate)".
   - "Valid until" shows the **year**; an IPv6 SAN reads `::1`, not `0:0:0:0:0:0:0:1`.
   - Record: a screenshot of the Certificate section.

8. **Capture, then clean up.** Into `/Users/seviyon/Repositories/tarballs/PiPulse/6b2b-exit/`: `sudo pipulse tls status --json`, `/api/health`, `/api/config | jq .tls`, `/api/alerts?state=all`, `journalctl -u pipulse -u pipulse-tls-renew --since today`. Leave Io on `0.6.5-rc1` over HTTPS with the generated certificate, or tell me where you want it.

---

## Results (send back; I update the plan, `CLAUDE.md` and open the PR with `release:patch`)

| Step                                                   | Result | Notes |
| ------------------------------------------------------ | ------ | ----- |
| 2 Active line matches the configured leaf; not running |        |       |
| 3 Failing renewal visible (status, Settings, health)   |        |       |
| 3 Recovery; tab refreshes by itself                    |        |       |
| 4 `cert_expiring` raised, Telegram                     |        |       |
| 4 `cert_expired` raised after it, in order             |        |       |
| 5 Hint page (Safari / Firefox / Chrome)                |        |       |
| 6 "CA is being replaced" line, then new scope          |        |       |
| 6 `generated-metadata-unreadable` and EACCES line      |        |       |
| 7 Warning expected: no (name) / yes (IP); year; `::1`  |        |       |
