#!/bin/sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
# Start clean: an earlier test in the same container may have installed PiPulse.
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
"$repo/packaging/build-tarball.sh" 0.0.2 "$out" >/dev/null
# 0.0.1 stands for a release from before the renewal timer: it ships no timer unit.
work1=$(mktemp -d); tar -xzf "$out/pipulse-0.0.1.tar.gz" -C "$work1"
rm -f "$work1"/pipulse-0.0.1/packaging/pipulse-tls-renew.*
tar -czf "$out/pipulse-0.0.1.tar.gz" -C "$work1" pipulse-0.0.1
# Break 0.0.2: it starts, but /api/health answers 503.
work=$(mktemp -d); tar -xzf "$out/pipulse-0.0.2.tar.gz" -C "$work"
# Like a real upgrade, it migrates the database first — which the old version then refuses.
cat > "$work/pipulse-0.0.2/packages/api/dist/server.js" <<'JS'
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.PIPULSE_DB_PATH);
db.exec('PRAGMA user_version = 99');
db.close();
createServer((q, s) => { s.statusCode = 503; s.end('{"status":"unhealthy"}'); }).listen(Number(process.env.PIPULSE_PORT));
JS
tar -czf "$out/pipulse-0.0.2.tar.gz" -C "$work" pipulse-0.0.2
# A stand-in for systemd: (re)start whatever is installed, on port 18889.
cat > /usr/local/bin/fake-stop <<'SH'
#!/bin/sh
pkill -f /opt/pipulse/app/packages/api/dist/server.js || true
sleep 1
SH
cat > /usr/local/bin/fake-restart <<'SH'
#!/bin/sh
fake-stop
PIPULSE_TLS=off PIPULSE_PORT=18889 PIPULSE_DB_PATH=/var/lib/pipulse/pipulse.sqlite PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist \
  nohup /opt/pipulse/node/bin/node --disable-warning=ExperimentalWarning /opt/pipulse/app/packages/api/dist/server.js >/tmp/rb.log 2>&1 &
SH
chmod +x /usr/local/bin/fake-restart /usr/local/bin/fake-stop
# The health check reads the port from pipulse.env, quoted as systemd allows.
mkdir -p /etc/pipulse && printf 'PIPULSE_PORT="18889"\nPIPULSE_TLS=off\n' > /etc/pipulse/pipulse.env
export PIPULSE_TEST_HOOKS=1 PIPULSE_RESTART_CMD=fake-restart PIPULSE_STOP_CMD=fake-stop PIPULSE_HEALTH_WAIT=20 PIPULSE_FORCE_RESTART=1
fail=0
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" && echo 'ok - good version installs' || { echo 'not ok - good version installs'; fail=1; }
# What the failed new version's setup would have left: its timer units and the "enabled once" marker.
mkdir -p /etc/systemd/system && : > /etc/systemd/system/pipulse-tls-renew.timer && : > /etc/systemd/system/pipulse-tls-renew.service && : > /etc/pipulse/.renew-timer-enabled
if sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.2.tar.gz"; then echo 'not ok - broken version reported success'; fail=1; else echo 'ok - broken version refused'; fi
grep -q '"0.0.1"' /opt/pipulse/app/version.json && echo 'ok - rolled back to 0.0.1' || { echo 'not ok - rolled back to 0.0.1'; fail=1; }
[ ! -e /etc/systemd/system/pipulse-tls-renew.timer ] && [ ! -e /etc/systemd/system/pipulse-tls-renew.service ] && [ ! -e /etc/pipulse/.renew-timer-enabled ] && echo 'ok - a rollback to a version without the timer removes its units and marker' || { echo 'not ok - a rollback to a version without the timer removes its units and marker'; fail=1; }
up=no; for _ in $(seq 1 20); do curl -fs http://127.0.0.1:18889/api/health >/dev/null 2>&1 && { up=yes; break; }; sleep 1; done
[ "$up" = yes ] && echo 'ok - 0.0.1 running again' || { echo 'not ok - 0.0.1 running again'; fail=1; }
# A version that accepts connections but never answers must not hang the installer.
"$repo/packaging/build-tarball.sh" 0.0.3 "$out" >/dev/null
work3=$(mktemp -d); tar -xzf "$out/pipulse-0.0.3.tar.gz" -C "$work3"
cat > "$work3/pipulse-0.0.3/packages/api/dist/server.js" <<'JS'
import { createServer } from 'node:net';
createServer(() => {}).listen(Number(process.env.PIPULSE_PORT)); // accepts, never answers
JS
tar -czf "$out/pipulse-0.0.3.tar.gz" -C "$work3" pipulse-0.0.3
started=$(date +%s)
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.3.tar.gz" >/dev/null 2>&1 || true
took=$(( $(date +%s) - started ))
[ "$took" -lt 120 ] && echo "ok - a silent version times out and rolls back (${took}s)" || { echo "not ok - installer hung (${took}s)"; fail=1; }
grep -q '"0.0.1"' /opt/pipulse/app/version.json && echo 'ok - still on 0.0.1' || { echo 'not ok - still on 0.0.1'; fail=1; }
# Another server holds the port and answers 200 to every path (as RPi-Monitor does on 8888):
# the new version can't listen, and that server's answer must not pass for PiPulse's health.
"$repo/packaging/build-tarball.sh" 0.0.4 "$out" >/dev/null
fake-stop
cat > /tmp/squatter.mjs <<'JS'
import { createServer } from 'node:http';
createServer((q, s) => s.end('<html>another server</html>')).listen(18889);
JS
nohup /opt/pipulse/node/bin/node /tmp/squatter.mjs >/dev/null 2>&1 &
squatter=$!
for _ in $(seq 1 20); do curl -fs http://127.0.0.1:18889/ >/dev/null 2>&1 && break; sleep 1; done
if sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.4.tar.gz" >/dev/null 2>&1; then
  echo 'not ok - another server on the port passed for PiPulse'; fail=1
else
  echo 'ok - another server on the port is not taken for PiPulse'
fi
grep -q '"0.0.1"' /opt/pipulse/app/version.json && echo 'ok - rolled back past the port clash' || { echo 'not ok - rolled back past the port clash'; fail=1; }
kill "$squatter"
# An upgrade that cannot copy the database (a full disk) must not leave PiPulse stopped.
"$repo/packaging/build-tarball.sh" 0.0.5 "$out" >/dev/null
fake-restart; for _ in $(seq 1 20); do curl -fs http://127.0.0.1:18889/api/health >/dev/null 2>&1 && break; sleep 1; done
[ -e /var/lib/pipulse/pipulse.sqlite ] || echo data > /var/lib/pipulse/pipulse.sqlite
: > /tmp/stops; : > /tmp/restarts
printf '#!/bin/sh\necho stopped >> /tmp/stops\nexec fake-stop\n' > /usr/local/bin/logged-stop
printf '#!/bin/sh\necho restarted >> /tmp/restarts\nexec fake-restart\n' > /usr/local/bin/logged-restart
chmod +x /usr/local/bin/logged-stop /usr/local/bin/logged-restart
if PIPULSE_STOP_CMD=logged-stop PIPULSE_RESTART_CMD=logged-restart PIPULSE_FREE_KB=1 sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.5.tar.gz" >/tmp/space.log 2>&1; then
  echo 'not ok - an upgrade with no room for the database copy went ahead'; fail=1
else
  grep -q 'not enough free space' /tmp/space.log && [ ! -s /tmp/stops ] && grep -q '"0.0.1"' /opt/pipulse/app/version.json && [ ! -e /opt/pipulse/app.new ] \
    && echo 'ok - no room for the copy: refused before the service was stopped, nothing changed' || { echo 'not ok - no-room refusal'; cat /tmp/space.log; fail=1; }
fi
mkdir -p /tmp/cpshim
printf '#!/bin/sh\ncase "$*" in *.pre-upgrade*) echo "cp: write error: No space left on device" >&2; exit 1 ;; esac\nexec /bin/cp "$@"\n' > /tmp/cpshim/cp
chmod +x /tmp/cpshim/cp
: > /tmp/stops; : > /tmp/restarts
if PATH=/tmp/cpshim:$PATH PIPULSE_STOP_CMD=logged-stop PIPULSE_RESTART_CMD=logged-restart sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.5.tar.gz" >/tmp/cpfail.log 2>&1; then
  echo 'not ok - an upgrade whose database copy failed went ahead'; fail=1
else
  grep -q 'could not copy the database' /tmp/cpfail.log && [ -s /tmp/stops ] && [ -s /tmp/restarts ] \
    && [ -z "$(ls /var/lib/pipulse/*.pre-upgrade 2>/dev/null)" ] && grep -q '"0.0.1"' /opt/pipulse/app/version.json && [ ! -e /opt/pipulse/app.new ] \
    && echo 'ok - a failed copy: no partial file left, the current version started again, nothing changed' || { echo 'not ok - failed-copy cleanup'; cat /tmp/cpfail.log; fail=1; }
fi
exit $fail
