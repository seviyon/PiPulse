#!/bin/sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
# Start clean: an earlier test in the same container may have installed PiPulse.
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
"$repo/packaging/build-tarball.sh" 0.0.2 "$out" >/dev/null
# Break 0.0.2: it starts, but /api/health answers 503.
work=$(mktemp -d); tar -xzf "$out/pipulse-0.0.2.tar.gz" -C "$work"
cat > "$work/pipulse-0.0.2/packages/api/dist/server.js" <<'JS'
import { createServer } from 'node:http';
createServer((q, s) => { s.statusCode = 503; s.end('{"status":"unhealthy"}'); }).listen(Number(process.env.PIPULSE_PORT));
JS
tar -czf "$out/pipulse-0.0.2.tar.gz" -C "$work" pipulse-0.0.2
# A stand-in for systemd: (re)start whatever is installed, on port 18889.
cat > /usr/local/bin/fake-restart <<'SH'
#!/bin/sh
pkill -f /opt/pipulse/app/packages/api/dist/server.js || true
sleep 1
PIPULSE_PORT=18889 PIPULSE_DB_PATH=/tmp/rb.sqlite PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist \
  nohup /opt/pipulse/node/bin/node --disable-warning=ExperimentalWarning /opt/pipulse/app/packages/api/dist/server.js >/tmp/rb.log 2>&1 &
SH
chmod +x /usr/local/bin/fake-restart
# The health check reads the port from pipulse.env, quoted as systemd allows.
mkdir -p /etc/pipulse && printf 'PIPULSE_PORT="18889"\n' > /etc/pipulse/pipulse.env
export PIPULSE_RESTART_CMD=fake-restart PIPULSE_HEALTH_WAIT=20 PIPULSE_FORCE_RESTART=1
fail=0
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" && echo 'ok - good version installs' || { echo 'not ok - good version installs'; fail=1; }
if sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.2.tar.gz"; then echo 'not ok - broken version reported success'; fail=1; else echo 'ok - broken version refused'; fi
grep -q '"0.0.1"' /opt/pipulse/app/version.json && echo 'ok - rolled back to 0.0.1' || { echo 'not ok - rolled back to 0.0.1'; fail=1; }
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
exit $fail
