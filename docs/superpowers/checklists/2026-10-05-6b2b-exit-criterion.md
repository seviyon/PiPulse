# 6b-2b exit criterion on `Io` — operator checklist (short form)

Plan task: Task 20 of `docs/superpowers/plans/2026-09-30-https-6b2.md`. Branch `phase-6b2b-visibility` (stacked on 6b-2a).
Everything here is manual: it needs the real Pi, its systemd unit and real browsers.

**Left out on purpose** (covered by unit tests, accepted by the operator 2026-10-05): the live Telegram delivery of certificate alerts (delivery was proven in 5b-3; ordering is tested with a fake clock), `chmod 000 ca-meta.json` (tested through `readGeneratedExtras`), the IPv6 `::1` display (tested through `compactIp`).

**Ground rules**

- Pi commands run over SSH as `seviyon@192.168.1.35` (password). Every path is absolute, one command per line.
- Use `io.local` or the IP. **Never `io.lan`** (it resolves to 192.168.1.50 on this LAN).
- Keep results in `/Users/seviyon/Repositories/tarballs/PiPulse/6b2b-exit/` (make it first). Capture state **before** anything is deleted (step 5).
- Io is expected on `0.6.4-rc1`, HTTPS, CA B generated, A as backup, both trusted on the Mac. Check with `sudo pipulse tls status` first.

---

1. **Install and status channel.**
   - Mac: `cd /Users/seviyon/Repositories/PiPulse && npm run build`
   - Mac: `sh /Users/seviyon/Repositories/PiPulse/packaging/build-tarball.sh 0.6.5-rc1 /Users/seviyon/Repositories/tarballs/PiPulse`
   - Mac: `scp /Users/seviyon/Repositories/tarballs/PiPulse/pipulse-0.6.5-rc1.tar.gz seviyon@192.168.1.35:/home/seviyon/tarballs/PiPulse/`
   - Mac: `scp /Users/seviyon/Repositories/PiPulse/packaging/install.sh seviyon@192.168.1.35:/home/seviyon/tarballs/PiPulse/`
   - Pi: `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --from /home/seviyon/tarballs/PiPulse/pipulse-0.6.5-rc1.tar.gz` (if Io is on HTTP afterwards: `sudo pipulse tls enable --yes`)
   - Pi: `sudo pipulse tls status` → `Active (the running server)` shows `HTTPS, pid …, serving SHA-256 …`, and that fingerprint **matches the configured leaf**.
   - Pi: `sudo ls -l /run/pipulse/tls-status.json` → owner `pipulse`, mode `0640`.
   - Pi: `sudo systemctl stop pipulse`, then `sudo pipulse tls status` → `not running (missing)`. Then `sudo systemctl start pipulse`.

2. **A failing renewal, through the real unit.** Keep a Settings tab open on `https://io.local:8889`.
   - Pi: `sudo chattr +i /etc/pipulse/tls/leaf.pem`
   - Pi, force a renewal:
     ```
     sudo mkdir -p /etc/systemd/system/pipulse-tls-renew.service.d
     printf '[Service]\nExecStart=\nExecStart=/usr/bin/pipulse tls renew --force\n' | sudo tee /etc/systemd/system/pipulse-tls-renew.service.d/force.conf
     sudo systemctl daemon-reload && sudo systemctl start pipulse-tls-renew.service
     sudo cat /etc/pipulse/tls/renew-status.json
     ```
   - Expect: `failed`; `sudo pipulse tls status` shows `Last renewal … FAILED`; the tab shows "Renewal failing: …" within a minute; `curl --cacert /Users/seviyon/pipulse-ca.crt https://io.local:8889/api/health` is `200`, `"status":"degraded"`, `renewal-failing` in `reasons`; the dashboard stays Live.
   - Pi: `sudo chattr -i /etc/pipulse/tls/leaf.pem`, then `sudo systemctl start pipulse-tls-renew.service` again.
   - Expect: `renewed`; health back to `ok`; **the tab updates by itself within a minute, no reload**.
   - Pi: `sudo rm -r /etc/systemd/system/pipulse-tls-renew.service.d && sudo systemctl daemon-reload`

3. **Browser pass** (Safari and Firefox; Chrome if you can).
   - **Hint page:** open `http://io.local:8889` → a small page "PiPulse uses HTTPS", not "Unable to connect". Pi: `curl -si http://io.local:8889/` shows `HTTP/1.1 400 Bad Request`.
   - **Settings, name:** `https://io.local:8889` → Certificate section shows "Certificate warning expected here: no …", and "Valid until" includes the **year**. Take a screenshot.
   - **Settings, IP:** `https://192.168.1.35:8889` (accept the warning if shown) → "yes (192.168.1.35 is not in the certificate)". Skip if CA B already covers the IP.
   - **CA change:** with the Settings tab open, Pi: `sudo pipulse tls new-ca --yes`. Until the reload (about two minutes) the tab says "The CA is being replaced; the served certificate has not switched yet" with no scope, and `curl --cacert … /api/health` shows `"metadata":"transitional"`, status `ok`. After the reload the new scope shows. Trust the new CA on the Mac if you keep it, or `sudo pipulse tls restore-ca` for the previous one.

4. **Certificate alerts, API only.**
   - Mac: make a throwaway CA and a leaf for `io`, `io.local`, `192.168.1.35` that expires **20 minutes from now** (`openssl ca -startdate <now> -enddate <now+20min>`, as in `packages/tls/test/fixtures/make-fixtures.sh`).
   - `scp` cert, key and CA to `/etc/pipulse/` with absolute paths; `root:pipulse`, key `640`.
   - In `/etc/pipulse/pipulse.env` set `PIPULSE_TLS=on`, `PIPULSE_TLS_CERT`, `PIPULSE_TLS_KEY`, `PIPULSE_TLS_CA`; `sudo systemctl restart pipulse`.
   - Expect within about 15 s: `cert_expiring` open (Alerts page and badge). At expiry: it clears and `cert_expired` opens.
   - Capture before restoring: `curl -k https://io.local:8889/api/alerts?state=all` (`-k` only because it has expired).
   - Restore: remove the operator lines from `pipulse.env`, `sudo systemctl restart pipulse`.

5. **Capture, then clean up.** Into `/Users/seviyon/Repositories/tarballs/PiPulse/6b2b-exit/`: `sudo pipulse tls status --json`, `/api/health`, `/api/config | jq .tls`, `/api/alerts?state=all`, `journalctl -u pipulse -u pipulse-tls-renew --since today`. Leave Io on `0.6.5-rc1` over HTTPS with the generated certificate.

---

## Results (send back; I update the plan, `CLAUDE.md` and open the PR with `release:patch`)

| Step                                                    | Result                  | Notes |
| ------------------------------------------------------- | ----------------------- | ----- |
| 1 Active line matches the configured leaf; not running  | pass                    | `HTTPS, pid 20836`, fingerprint B5:F9:40… matched; `not running (missing)` when stopped |
| 2 Failing renewal visible (status, Settings, health)    | pass (Settings not seen)| `failed` EPERM; `degraded` + `renewal-failing`; Settings tab not reported |
| 2 Recovery; tab refreshes by itself                     | pass / unconfirmed      | `renewed`, health `ok`; tab refresh not reported |
| 3 Hint page (Safari / Firefox / Chrome)                 | pass (Safari + one more)| second browser not named; `curl` also 400 + body |
| 3 Warning expected: no (name) / yes (IP); year          | name pass, IP not seen  | year, `::1`, CA fingerprint shown |
| 3 "CA is being replaced" line, then new scope           | pass                    | `transitional` in health, status `ok`; `restore-ca` back to A |
| 4 `cert_expiring` raised, then `cert_expired` after it  | raise pass; expired not run | closed by condition on a longer-lived certificate; the expiry crossing is fake-clock tested only |
