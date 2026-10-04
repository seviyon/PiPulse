# 6b-2a exit criterion on `Io` — operator checklist

Plan task: Task 13 of `docs/superpowers/plans/2026-09-30-https-6b2.md`. Branch `phase-6b2a-issuance`.
Everything here is manual: browser trust lives in the OS keychain, so no test can stand in for it.

**Ground rules**

- Pi commands run over SSH as `seviyon@192.168.1.35` (password). Every path is absolute, one command per line.
- Use `io.local` or the IP. **Never `io.lan`**: on this LAN it resolves to another host (192.168.1.50).
- `Io` runs 0.6.3-rc1 over plain HTTP with an admin password on port 8889. `disable` therefore needs `--allow-insecure`.
- Keep results in `/Users/seviyon/Repositories/tarballs/PiPulse/6b2a-exit/` (make it first). Paste the "Record" lines of each step into the table at the end.
- Capture state (`status --json`, `/api/health`, `journalctl`) **before** anything is deleted (step 14).

**Browsers under test:** Safari, Chrome, Firefox (needs `security.enterprise_roots.enabled` = `true` in `about:config`). Write down each browser's version and the macOS version once, at the top of the table.

---

## Part 0 — D2 gate (do this BEFORE `init` on Io)

`Io`'s host name is `io`, which is also a real top-level domain. With D2 off (today) the CA is permitted for `io` and therefore for every `*.io` name. Whether browsers enforce an exclusion of `.io` decides if D2 can be turned on, and **a CA's constraints never change after it is made**, so this comes first.

1. On the Mac: `cd /Users/seviyon/Repositories/PiPulse && npx tsx packages/tls/test/browser-kit.ts /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit "$(ipconfig getifaddr en0)"`
2. `sudo sh -c 'printf "127.0.0.1 pipulse-check pipulse-check.local other-check.lan x.pipulse-check io x.io # browser-kit\n" >> /etc/hosts'`
3. `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit/ca.crt`
4. `node /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit/serve.mjs` (leave it running)
5. In each browser open these seven URLs and note **loads** or the **exact error**:

   | Port | URL                            | Expected                          |
   | ---- | ------------------------------ | --------------------------------- |
   | 8441 | `https://pipulse-check:8441`   | loads                             |
   | 8442 | `https://127.0.0.1:8442`       | loads                             |
   | 8443 | `https://other-check.lan:8443` | refused (name outside constraint) |
   | 8444 | `https://<Mac LAN IP>:8444`    | refused (IP outside constraint)   |
   | 8445 | `https://x.pipulse-check:8445` | refused (excluded subtree)        |
   | 8446 | `https://io:8446`              | loads                             |
   | 8447 | `https://x.io:8447`            | refused (excluded subtree)        |

6. Clean up: `sudo security delete-certificate -c "PiPulse browser check CA" /Library/Keychains/System.keychain` and `sudo sed -i '' '/# browser-kit/d' /etc/hosts`.

**Decision** (I record it in the plan, Task 1 Step 7b, and in Task 2 Step 6):

- All three browsers load 8441 and 8446 **and** refuse 8445 and 8447 with a constraint error → D2 goes **on** (a new commit), and only then do you run `init` on Io.
- Any browser loads 8443 or 8444 → name constraints are advisory there: stop and tell me.
- Anything else → D2 stays **off**; the README already states the TLD risk, and you decide whether Io should keep the name `io` for a generated CA (the alternative is a different host name before `init`).

---

## Part 1 — Build, install, first CA

1. **Spike on OpenSSL 1.1.1** — already recorded (1.1.1w, 102/102). Skip.
2. **Build and copy** (Mac):
   - `cd /Users/seviyon/Repositories/PiPulse && npm run build`
   - `sh /Users/seviyon/Repositories/PiPulse/packaging/build-tarball.sh 0.6.4-rc1 /Users/seviyon/Repositories/tarballs/PiPulse`
   - `scp /Users/seviyon/Repositories/tarballs/PiPulse/pipulse-0.6.4-rc1.tar.gz seviyon@192.168.1.35:/home/seviyon/tarballs/PiPulse/`
   - `scp /Users/seviyon/Repositories/PiPulse/packaging/install.sh seviyon@192.168.1.35:/home/seviyon/tarballs/PiPulse/`
3. **Install** (Pi): `sudo sh /home/seviyon/tarballs/PiPulse/install.sh --from /home/seviyon/tarballs/PiPulse/pipulse-0.6.4-rc1.tar.gz`
   - Expect: `running 0.6.4-rc1`, still plain HTTP, `sudo ls /etc/pipulse` shows **no `tls`**, and `systemctl list-timers pipulse-tls-renew.timer` lists the timer.
   - Record: the install output, and the line from `list-timers`.
4. **Status, init, status** (Pi): `sudo pipulse tls status`, then `sudo pipulse tls init`, then `sudo pipulse tls status`.
   - Expect: the first says nothing is generated; `init` prints the CA fingerprint and a names-only scope (no IP range); the last shows the same fingerprint.
   - Record: the CA fingerprint (**call it A**), the names it covers.
5. **Export and verify out of band** (criterion 2):
   - Pi: `sudo pipulse tls export-ca --out /home/seviyon/pipulse-ca.crt`
   - Mac: `scp seviyon@192.168.1.35:/home/seviyon/pipulse-ca.crt /Users/seviyon/Repositories/tarballs/PiPulse/6b2a-exit/ca-A.crt`
   - Mac: `openssl x509 -in /Users/seviyon/Repositories/tarballs/PiPulse/6b2a-exit/ca-A.crt -noout -fingerprint -sha256`
   - **Compare it with A from the SSH output yourself.** Only then trust it: System keychain, Always Trust (Safari and Chrome); Firefox via enterprise roots.
6. **Enable** (Pi): `sudo pipulse tls enable` (answer `y`). It prints the HTTPS URL.
   - In Safari, Chrome, Firefox: `https://io:8889` and `https://io.local:8889` load **without a warning** and the dashboard goes **Live over `wss://`**. `https://192.168.1.35:8889` **shows a warning**.
   - Record: per browser, loads/warns, and the IP warning's error class.

## Part 2 — Rollover (where these systems usually fail)

7. **Scope change, CA A → CA B** (criterion 3). Pi: `sudo pipulse tls new-ca --subnet 192.168.1.0/24` (answer `y`). Capture `sudo pipulse tls status` before and after.
   - Within about 2 minutes (no restart: `systemctl show -p ActiveEnterTimestamp pipulse` unchanged) **reload each browser before trusting B**.
   - Expect: every browser now **warns** about the names too (it still only trusts A). This is the cost `new-ca` warns about: confirm the warning text is what a user would understand.
   - Record: per browser, the error class; the new fingerprint (**B**); `status` showing A as `ca.old-…`.
8. **Trust B**: export it (as in step 5, file `ca-B.crt`), compare the fingerprint with SSH output, trust it.
   - Expect: `https://io:8889`, `https://io.local:8889` **and `https://192.168.1.35:8889`** now load without a warning in all three.
9. **Leaf renewal with a tab open** (criterion 5 part 1). Keep a Live dashboard tab open. Pi: `sudo pipulse tls renew --force`.
   - Expect: the open tab stays Live (its socket is old and keeps working); a **reload** loads fine over the new leaf; Settings → Certificate (or `curl --cacert … /api/config | jq .tls`) shows the new leaf's fingerprint and dates. No restart.
   - Record: whether the open tab stayed Live, and whether the reload needed anything.
10. **A new address, DHCP-style** (criterion 5). Pi: `sudo ip addr add 192.168.1.36/24 dev eth0`, then `sudo pipulse tls renew`.
    - Expect: `renewed (the default-route address 192.168.1.36 is not in it)`; within ~2 minutes `https://192.168.1.36:8889` loads without a warning; no restart.
    - Then: `sudo ip addr del 192.168.1.36/24 dev eth0`.
    - IPv6 (only if `ip -6 addr show dev eth0 scope global` lists an address): note whether the SAN list in `sudo pipulse tls status` follows it, and that a **new** IPv6 address does not trigger a renewal within the first day (`IPV6_RENEW_AFTER_MS`). If there is no global IPv6, write "N/A".
11. **Restore the first CA** (criterion 3). Pi: `sudo pipulse tls restore-ca <the ca.old-… name from status> --yes`.
    - Expect: fingerprint is **A** again and the scope is names-only again. **A is still trusted on the Mac**, so the names load with **no re-trust**; the IP address warns again (A covers no range). That is the rollback path an operator will rely on.
    - Record: per browser, names OK / IP warns.
12. **Backup limit.** Pi: run `sudo pipulse tls new-ca --yes` twice, then once more.
    - Expect: the third is **refused** with the exact `--prune-oldest ca.old-…` to pass; with it, the command succeeds and `status` lists two backups.
13. **Untrust the old CA.** On the Mac, remove **A** from the keychain (keep B trusted; make B the active CA first with `restore-ca` if needed).
    - Expect: the site still loads. Then remove B too and confirm the warning returns (proves the browsers were using the keychain, not a cached exception).

## Part 3 — Failure and sandbox

14. **Killed mid-change** (criterion 4). Pi:
    - `sudo sh -c 'pipulse tls new-ca --subnet 192.168.1.0/24 --yes & p=$!; sleep 0.4; kill -9 $p'`
    - `sudo ls -a /etc/pipulse/tls` (a `txn.json` or `.next-*` may be there)
    - `sudo pipulse tls renew`, then `sudo pipulse tls status`
    - Expect: exactly one CA, a leaf that verifies, no leftovers. Repeat with `sleep 0.1` and `sleep 1`.
15. **No clock** (criterion 7). Pi: `sudo systemctl disable --now systemd-timesyncd && sudo reboot`. After boot:
    - `sudo systemctl start pipulse-tls-renew.service; sudo cat /etc/pipulse/tls/renew-status.json` → `waiting-clock`; the site keeps serving.
    - **Confirm the unit did not fail on `pipulse.env`**: `sudo journalctl -u pipulse-tls-renew --since today --no-pager` must not contain `can't read /etc/pipulse/pipulse.env`. Record whether the sandbox shows that file as missing or as permission denied (see the probe in step 16: it prints which).
    - `sudo systemctl enable --now systemd-timesyncd`; once `timedatectl` says synchronized, force one timer-driven renewal:
      ```
      sudo mkdir -p /etc/systemd/system/pipulse-tls-renew.service.d
      printf '[Service]\nExecStart=\nExecStart=/usr/bin/pipulse tls renew --force\n' | sudo tee /etc/systemd/system/pipulse-tls-renew.service.d/force.conf
      sudo systemctl daemon-reload && sudo systemctl start pipulse-tls-renew.service && sudo cat /etc/pipulse/tls/renew-status.json
      sudo rm -r /etc/systemd/system/pipulse-tls-renew.service.d && sudo systemctl daemon-reload
      ```
      Expect `renewed`. Record the journal.
16. **The real sandbox** (criterion 10). Run a probe under the unit's own sandbox:
    ```
    sudo mkdir -p /etc/systemd/system/pipulse-tls-renew.service.d
    printf '%s\n' '[Service]' 'ExecStart=' "ExecStart=/bin/sh -c 'for f in /var/lib/pipulse/pipulse.sqlite /etc/pipulse/admin.hash /etc/pipulse/rules.json /etc/pipulse/notify.json /etc/pipulse/pipulse.env /etc/pipulse/tls/leaf.pem; do if cat \"\$f\" >/dev/null 2>&1; then echo \"READABLE \$f\"; else echo \"hidden \$f: \$(cat \"\$f\" 2>&1 | head -n 1)\"; fi; done; touch /etc/pipulse/tls/.probe && echo writable-tls && rm /etc/pipulse/tls/.probe; ip -o -4 addr show'" | sudo tee /etc/systemd/system/pipulse-tls-renew.service.d/probe.conf
    sudo systemctl daemon-reload && sudo systemctl start pipulse-tls-renew.service; journalctl -u pipulse-tls-renew -n 25 --no-pager
    sudo rm -r /etc/systemd/system/pipulse-tls-renew.service.d && sudo systemctl daemon-reload
    ```
    - Expect: `hidden` for the database, hash, rules, notify file and `pipulse.env` (with the reason text: this answers the ENOENT-vs-EACCES question); `READABLE /etc/pipulse/tls/leaf.pem`; `writable-tls`; the interface addresses.
    - If `writable-tls` is missing, remove `ReadWritePaths=` or `BindPaths=` (whichever systemd 247 objects to) and repeat; tell me which.
    - Also run `sudo systemd-analyze security pipulse-tls-renew.service` and record the exposure score.
17. **Back to HTTP.** Pi: `sudo pipulse tls disable --allow-insecure` (answer `y`).
    - Expect: `http://io:8889` answers; `/etc/pipulse/tls` is intact; Settings shows the `legacy-http` banner with `sudo pipulse tls enable`.
18. **Capture before cleaning up** into `/Users/seviyon/Repositories/tarballs/PiPulse/6b2a-exit/`: `sudo pipulse tls status --json`, `curl --cacert … /api/health`, `/api/config | jq .tls`, `journalctl -u pipulse -u pipulse-tls-renew --since today`. Remove the test CAs from the Mac keychain unless you keep them. Leave Io on 0.6.4-rc1 over HTTP, or tell me where you want it.

---

## Results table (fill in; send it back and I update the plan, `CLAUDE.md` and the PR)

| Item                                                          | Safari | Chrome | Firefox | Notes |
| ------------------------------------------------------------- | ------ | ------ | ------- | ----- |
| Versions (browser, macOS)                                     |        |        |         |       |
| Part 0: 8441 / 8442 load                                      |        |        |         |       |
| Part 0: 8443 / 8444 / 8445 refused (error class)              |        |        |         |       |
| Part 0: 8446 loads, 8447 refused (D2)                         |        |        |         |       |
| 6: names load, Live over `wss://`                             |        |        |         |       |
| 6: IP warns (error class)                                     |        |        |         |       |
| 7: after `new-ca`, before trusting B: warns (error class)     |        |        |         |       |
| 8: after trusting B: names and IP load                        |        |        |         |       |
| 9: open tab stays Live after forced renewal; reload fine      |        |        |         |       |
| 11: after `restore-ca`: names load without re-trust; IP warns |        |        |         |       |
| 13: after untrusting: warning returns                         |        |        |         |       |

| Pi item                                                                 | Result |
| ----------------------------------------------------------------------- | ------ |
| 3: version, no `/etc/pipulse/tls`, timer listed                         |        |
| 4: fingerprint A, names-only scope                                      |        |
| 7: fingerprint B, backup listed, no restart                             |        |
| 10: renewal reason, no restart; IPv6 note or N/A                        |        |
| 12: third `new-ca` refused, then ok with `--prune-oldest`               |        |
| 14: kill at 0.1 / 0.4 / 1 s: one CA, leaf verifies, no leftovers        |        |
| 15: `waiting-clock`; no `pipulse.env` error; forced renewal `renewed`   |        |
| 16: probe output (reason for hidden `pipulse.env`), writable-tls, score |        |
| 17: back on HTTP, banner shown                                          |        |
