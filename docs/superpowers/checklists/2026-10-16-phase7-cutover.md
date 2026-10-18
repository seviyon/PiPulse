# Phase 7 cutover: retire RPi-Monitor on `Io`

Exit criterion (`docs/PLAN.md`, Phase 7): PiPulse has run a full week unattended with no data gaps, then `rpimonitord` is decommissioned. The soak started **2026-10-09 12:09 UTC**, so the earliest cutover is **2026-10-16 about 12:10 UTC**. Nothing here is run before that. No release goes out before the week of 2026-10-19.

Rehearsed on 2026-10-13 in a Debian container with real systemd (a fake legacy daemon answering every path with 200 on port 8888, PiPulse installed from a tarball): steps 4 to 7 behave as written. The rehearsal could not cover `ufw`, the Pi's firmware, or your Pi-hole.

All commands use absolute paths. Steps marked **Mac** run on your Mac, steps marked **Io** over SSH on the Pi (`sudo` asks for the password).

## 1. Gap check (Mac)

```
python3 -I /Users/seviyon/Repositories/PiPulse/scripts/phase7-gaps.py
```

Defaults: host `io.local`, window start `2026-10-09T12:10:00+00:00`. The Mac already trusts the PiPulse CA. Exit code and what it means:

- `0`: every metric has 1-minute buckets with no hole longer than 3 minutes, no missing start and no missing tail. Continue.
- `1`: it prints each hole (`no data MM-DD HH:MM -> MM-DD HH:MM UTC`). Decide whether it matters (a reboot, a power cut) and write the cause down; the exit criterion says "no data gaps", so a real gap restarts the week or is explained in the record.
- `2`: PiPulse can't be read (message says why: certificate, name, network).

Record the output in `~/Repositories/tarballs/PiPulse/phase7/gaps-final.txt`.

## 2. Alerts and notifications (Mac)

```
curl -s 'https://io.local:8889/api/alerts?state=all' | python3 -m json.tool | head -60
```

Look at what opened and closed during the week and whether the Telegram messages arrived for each. Nothing unexplained should be open.

## 3. The two Pi-only oddities from the 5b-2 run (Mac)

```
curl -s https://io.local:8889/api/alerts/rules | python3 -c 'import sys,json; print({r["id"]: r.get("kind") for r in json.load(sys.stdin)["rules"]})'
curl -s https://io.local:8889/ | grep -o 'assets/index-[^"]*\.js'
```

- Every built-in rule should say `built-in`. If the "Built-in" label is still missing on the Alerts page in the browser, compare the file name above with the one on the Pi (step in section 4); a mismatch means a stale bundle.
- Capture `/api/alerts?state=all` before touching anything (section 2) so the "acknowledged alert closed on restart" question can still be answered.

## 4. Before stopping anything (Io)

```
sudo systemctl is-active pipulse rpimonitor
ss -ltnp | grep -E ':(8888|8889)\b'
ls /opt/pipulse/app/packages/web/dist/assets/
sudo journalctl -u pipulse --since '7 days ago' --no-pager | grep -ciE 'error|failed'
```

Expect both services `active`, one listener on each port, and the asset file name equal to the one in section 3. Note the error count (the Pi's known `vcgencmd` one-liners right after a boot are fine).

Side by side: open `http://io:8888/status.html` and `https://io.local:8889/` next to each other once more and compare CPU temperature, load, memory, swap, disk and network. Parity table: `docs/PLAN.md`.

## 5. Decommission (Io)

```
sudo systemctl stop rpimonitor
sudo systemctl disable rpimonitor
```

Check:

```
systemctl is-active rpimonitor        # inactive
systemctl is-enabled rpimonitor       # disabled
curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:8888/   # 000: refused
curl -s -o /dev/null -w '%{http_code}\n' https://io.local:8889/api/health       # (Mac) 200
ls /etc/rpimonitor/                    # its configuration is still there
```

`rpimonitord` is a separate service, so Pi-hole and PiPulse are not touched. Leave the package installed and its configuration in place for now.

## 6. Firewall (Io, optional)

`ufw` is active with default DROP. The old port 8888 rule is now pointless but harmless. Look before changing anything:

```
sudo ufw status numbered
```

Delete only the rule for 8888, by its number, if you want it gone: `sudo ufw delete <number>`. Do not touch the rules for DNS, SSH or the Pi-hole web port.

## 7. After a restart (optional, Io)

PiPulse starts by itself and `rpimonitord` stays off. The rehearsal checked a service restart; a reboot also takes the Pi-hole's DNS down for a minute, so it is your call:

```
sudo reboot
```

Then from the Mac: `curl -s https://io.local:8889/api/health` and `ssh` back in for `systemctl is-enabled rpimonitor` (disabled). The hour or so right after a boot can show a `vcgencmd` empty answer once and `clock-unknown` health reasons until timesyncd syncs; both clear by themselves.

## 8. Rollback

```
sudo systemctl enable --now rpimonitor
```

RPi-Monitor is back on 8888 with its old configuration; PiPulse keeps running next to it.

## 9. Afterwards

- Tell me the result: I update `README.md` (roadmap: Phase 7 done), `docs/PLAN.md` and `CLAUDE.md`, and record the gap-check output.
- After a month with no regrets: `sudo apt remove rpimonitor` (not `purge`, so the configuration stays).
- `/etc/cron.d/rpimonitor` still runs `apt-get update` at 03:05 every night, as root, after the service is stopped, and `remove` keeps it (a conffile); `purge` deletes it. It is harmless (apt's own `apt-daily.timer` refreshes the lists too, `Update-Package-Lists "1"` on `Io`), and PiPulse does not depend on it.

## Rehearsal findings (2026-10-13)

- The cutover steps above worked in a systemd container: both services side by side, stop and disable left PiPulse untouched, port 8888 refused, configuration kept, `rpimonitord` stayed disabled across a PiPulse restart, the rollback brought the legacy daemon back.
- The legacy daemon answers every path with 200, as RPi-Monitor does: check PiPulse by its own `/api/health` body, never by a bare 200.
- `scripts/phase7-gaps.py` was tested against a real server with a seeded database: an 11-minute hole exits 1 and is named; a window that starts before the first data exits 1; a filled window exits 0; an unreachable server exits 2.
- The installer printed "port 8889 is already in use by MainThread" about its own service on Node 24 (the process name). Fixed: the check compares the holder's PID with the service's main PID.
