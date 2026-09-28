#!/bin/sh
# A Pi that has a tarball install, then runs the apt one-liner: it must end up a
# clean apt install that keeps the operator's settings and data.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
apt-get purge -y pipulse >/dev/null 2>&1 || true
arch=$(dpkg --print-architecture)
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
"$repo/packaging/build-tarball.sh" 0.0.2 "$out" >/dev/null
"$repo/packaging/build-deb.sh" 0.0.2 "$arch" "$out/pipulse-0.0.2.tar.gz" "$out" >/dev/null
# A local signed apt repository standing in for GitHub Pages.
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
gpg --batch --passphrase '' --quick-gen-key 'PiPulse test <test@example.invalid>' default default never 2>/dev/null
apt_dir=$(mktemp -d)
sh "$repo/packaging/apt-publish.sh" "$apt_dir" 3 "$out/pipulse_0.0.2_$arch.deb" >/dev/null
chmod -R a+rX "$apt_dir"
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }

# The tarball install, with an edited settings file, data, and the unit it installs.
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start >/dev/null
echo 'PIPULSE_PORT=8889' >> /etc/pipulse/pipulse.env
echo data > /var/lib/pipulse/pipulse.sqlite
mkdir -p /etc/systemd/system && cp "$repo/packaging/pipulse.service" /etc/systemd/system/pipulse.service
touch /opt/pipulse/app/tarball-only-leftover

# The one-liner, run the way curl | sudo sh runs it: stdin is not a terminal.
if PIPULSE_APT_URL="file://$apt_dir" sh "$repo/packaging/install.sh" < /dev/null > /tmp/migrate.log 2>&1; then ok 'apt install over a tarball install succeeds'; else cat /tmp/migrate.log; bad 'apt install over a tarball install succeeds'; fi
dpkg-query -W -f='${Status}' pipulse 2>/dev/null | grep -q 'install ok installed' && ok 'pipulse is now an apt package' || bad 'pipulse is now an apt package'
grep -q '"0.0.2"' /opt/pipulse/app/version.json 2>/dev/null && ok 'the packaged version is in place' || bad 'the packaged version is in place'
[ ! -e /etc/systemd/system/pipulse.service ] && ok 'the tarball unit no longer shadows the packaged one' || bad 'the tarball unit no longer shadows the packaged one'
[ ! -e /opt/pipulse/app/tarball-only-leftover ] && ok 'no tarball leftovers in /opt/pipulse' || bad 'no tarball leftovers in /opt/pipulse'
grep -q '^PIPULSE_PORT=8889$' /etc/pipulse/pipulse.env && ok 'edited settings kept' || bad 'edited settings kept'
grep -q '^data$' /var/lib/pipulse/pipulse.sqlite && ok 'data kept' || bad 'data kept'

apt-get purge -y pipulse >/dev/null 2>&1 || true
rm -f /etc/apt/sources.list.d/pipulse.list /usr/share/keyrings/pipulse.gpg
exit $fail
