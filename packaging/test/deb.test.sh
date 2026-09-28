#!/bin/sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
# Start clean: an earlier test in the same container may have installed PiPulse.
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
apt-get purge -y pipulse >/dev/null 2>&1 || true
arch=$(dpkg --print-architecture)
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
"$repo/packaging/build-tarball.sh" 0.0.2 "$out" >/dev/null
"$repo/packaging/build-deb.sh" 0.0.1 "$arch" "$out/pipulse-0.0.1.tar.gz" "$out" >/dev/null
"$repo/packaging/build-deb.sh" 0.0.2 "$arch" "$out/pipulse-0.0.2.tar.gz" "$out" >/dev/null
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
lintian --fail-on error "$out/pipulse_0.0.1_$arch.deb" && ok 'lintian clean' || bad 'lintian clean'
apt-get install -y "$out/pipulse_0.0.1_$arch.deb" >/dev/null && ok 'installs' || bad 'installs'
[ -x /opt/pipulse/node/bin/node ] && id pipulse >/dev/null && ok 'node and user' || bad 'node and user'
echo 'PIPULSE_PORT=8889' >> /etc/pipulse/pipulse.env
DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold "$out/pipulse_0.0.2_$arch.deb" >/dev/null && ok 'upgrades' || bad 'upgrades'
grep -q '"0.0.2"' /opt/pipulse/app/version.json && ok 'new version in place' || bad 'new version in place'
grep -q '^PIPULSE_PORT=8889$' /etc/pipulse/pipulse.env && ok 'edited env kept' || bad 'edited env kept'
apt-get remove -y pipulse >/dev/null
[ ! -e /opt/pipulse ] && [ -f /etc/pipulse/pipulse.env ] && [ -d /var/lib/pipulse ] && ok 'remove keeps data and settings' || bad 'remove keeps data and settings'
apt-get purge -y pipulse >/dev/null
[ ! -e /etc/pipulse ] && [ ! -e /var/lib/pipulse ] && ! getent passwd pipulse >/dev/null && ok 'purge removes everything' || bad 'purge removes everything'
exit $fail
