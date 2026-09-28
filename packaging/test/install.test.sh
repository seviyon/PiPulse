#!/bin/sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
# Start clean: an earlier test in the same container may have installed PiPulse.
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.0-test "$out" >/dev/null
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.0-test.tar.gz" --no-start || bad 'install ran'
[ -x /opt/pipulse/node/bin/node ] && ok 'private node' || bad 'private node'
[ -f /opt/pipulse/app/version.json ] && ok 'app installed' || bad 'app installed'
[ -x /usr/bin/pipulse ] && ok 'pipulse command' || bad 'pipulse command'
pipulse version | grep -q '^PiPulse 0.0.0-test, Node v' && ok 'pipulse version' || bad 'pipulse version'
# Start it the way the unit would and check it answers.
su -s /bin/sh pipulse -c 'cd /var/lib/pipulse && PIPULSE_DB_PATH=/var/lib/pipulse/pipulse.sqlite PIPULSE_PORT=18888 PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist /opt/pipulse/node/bin/node --disable-warning=ExperimentalWarning /opt/pipulse/app/packages/api/dist/server.js' & pid=$!
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:18888/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fs http://127.0.0.1:18888/api/config | grep -q '"version":"0.0.0-test"' && ok 'serves the stamped version' || bad 'serves the stamped version'
kill $pid; wait $pid 2>/dev/null || true
sh "$repo/packaging/install.sh" --uninstall
[ ! -e /opt/pipulse ] && [ -d /var/lib/pipulse ] && [ -f /etc/pipulse/pipulse.env ] && ok 'uninstall keeps data and settings' || bad 'uninstall keeps data and settings'
sh "$repo/packaging/install.sh" --purge
! getent passwd pipulse >/dev/null && [ ! -e /var/lib/pipulse ] && [ ! -e /etc/pipulse ] && ok 'purge removes everything' || bad 'purge removes everything'
exit $fail
