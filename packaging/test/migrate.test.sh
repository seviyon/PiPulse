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

tarball_intact() {
  grep -q '"0.0.1"' /opt/pipulse/app/version.json 2>/dev/null && [ -x /usr/bin/pipulse ] &&
    [ -e /etc/systemd/system/pipulse.service ] && [ -e /opt/pipulse/app/tarball-only-leftover ] &&
    ! dpkg-query -W -f='${Status}' pipulse 2>/dev/null | grep -q 'install ok installed'
}

# 1. The repository can't be reached: nothing may change.
if PIPULSE_APT_URL="file:///nonexistent/apt" sh "$repo/packaging/install.sh" < /dev/null > /tmp/migrate.log 2>&1; then bad 'fails when the repository is unreachable'; else ok 'fails when the repository is unreachable'; fi
tarball_intact && ok 'unreachable repository: tarball install untouched' || bad 'unreachable repository: tarball install untouched'
[ ! -e /etc/apt/sources.list.d/pipulse.list ] && ok 'unreachable repository: no apt source left behind' || bad 'unreachable repository: no apt source left behind'

# 2. The package fails to install (its preinst fails): the tarball install comes back.
bad_dir=$(mktemp -d)
dpkg-deb -R "$out/pipulse_0.0.2_$arch.deb" "$bad_dir/pkg"
printf '#!/bin/sh\necho "simulated preinst failure" >&2\nexit 1\n' > "$bad_dir/pkg/DEBIAN/preinst"
dpkg-deb --root-owner-group --build "$bad_dir/pkg" "$bad_dir/pipulse_0.0.2_$arch.deb" >/dev/null
bad_repo=$(mktemp -d)
sh "$repo/packaging/apt-publish.sh" "$bad_repo" 3 "$bad_dir/pipulse_0.0.2_$arch.deb" >/dev/null
chmod -R a+rX "$bad_repo"
if PIPULSE_APT_URL="file://$bad_repo" sh "$repo/packaging/install.sh" < /dev/null > /tmp/migrate.log 2>&1; then bad 'fails when the package fails to install'; else ok 'fails when the package fails to install'; fi
tarball_intact && ok 'failed package: tarball install restored' || { cat /tmp/migrate.log; bad 'failed package: tarball install restored'; }
[ ! -e /etc/apt/sources.list.d/pipulse.list ] && ok 'failed package: no apt source left behind' || bad 'failed package: no apt source left behind'

# 2b. It fails later, in postinst (after unpacking): the settings and data must survive
#     the clean-up too, not only the tarball.
printf '#!/bin/sh\necho "simulated postinst failure" >&2\nexit 1\n' > "$bad_dir/pkg/DEBIAN/postinst"
printf '#!/bin/sh\nexit 0\n' > "$bad_dir/pkg/DEBIAN/preinst"
rm -f "$bad_dir/pipulse_0.0.2_$arch.deb"
dpkg-deb --root-owner-group --build "$bad_dir/pkg" "$bad_dir/pipulse_0.0.2_$arch.deb" >/dev/null
rm -rf "$bad_repo"; bad_repo=$(mktemp -d)
sh "$repo/packaging/apt-publish.sh" "$bad_repo" 3 "$bad_dir/pipulse_0.0.2_$arch.deb" >/dev/null
chmod -R a+rX "$bad_repo"
if PIPULSE_APT_URL="file://$bad_repo" sh "$repo/packaging/install.sh" < /dev/null > /tmp/migrate.log 2>&1; then bad 'fails when postinst fails'; else ok 'fails when postinst fails'; fi
tarball_intact && ok 'failed postinst: tarball install restored' || { cat /tmp/migrate.log; bad 'failed postinst: tarball install restored'; }
grep -q '^PIPULSE_PORT=8889$' /etc/pipulse/pipulse.env 2>/dev/null && ok 'failed postinst: settings kept' || bad 'failed postinst: settings kept'
grep -q '^data$' /var/lib/pipulse/pipulse.sqlite 2>/dev/null && ok 'failed postinst: data kept' || bad 'failed postinst: data kept'
rm -rf /var/lib/apt/lists/*_nonexistent_* /var/lib/apt/lists/_tmp_* 2>/dev/null || true

# 3. The one-liner, run the way curl | sudo sh runs it: stdin is not a terminal.
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
