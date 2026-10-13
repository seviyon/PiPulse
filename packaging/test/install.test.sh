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
[ -z "$(find /opt/pipulse ! -type l -perm /022 | head -n 1)" ] && ok 'nothing under /opt/pipulse is writable by group or others (root runs the upgrade helper from there)' || bad 'nothing under /opt/pipulse is writable by group or others'
[ -x /opt/pipulse/node/bin/node ] && ok 'private node' || bad 'private node'
[ -f /opt/pipulse/app/version.json ] && ok 'app installed' || bad 'app installed'
[ -x /usr/bin/pipulse ] && ok 'pipulse command' || bad 'pipulse command'
pipulse version | grep -q '^PiPulse 0.0.0-test, Node v' && ok 'pipulse version' || bad 'pipulse version'
# A tarball whose members belong to another uid (the release runner's 1001) and carry a setuid
# bit must not leave either behind in /opt/pipulse: root runs scripts from there.
sh "$repo/packaging/install.sh" --uninstall >/dev/null 2>&1 || true
mkdir -p "$out/hostile" && tar -xzf "$out/pipulse-0.0.0-test.tar.gz" -C "$out/hostile"
chmod 4755 "$out/hostile/pipulse-0.0.0-test/packaging/setup.sh"
tar --owner=1001 --group=1001 --numeric-owner -czf "$out/pipulse-0.0.0-hostile.tar.gz" -C "$out/hostile" pipulse-0.0.0-test
# What is in the tree at the moment it is moved into /opt/pipulse, where another user can reach
# it: a shim in front of mv looks at the source of that one move.
mkdir -p "$out/shim"
cat > "$out/shim/mv" <<'SHIM'
#!/bin/sh
case "$2" in
  /opt/pipulse/app.new) find "$1" \( -not -user root -o -not -group root -o -perm /6000 \) > /tmp/pipulse-mv-window.log ;;
esac
exec /bin/mv "$@"
SHIM
chmod +x "$out/shim/mv"
rm -f /tmp/pipulse-mv-window.log
PATH="$out/shim:$PATH" sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.0-hostile.tar.gz" --no-start >/dev/null || bad 'install of a 1001-owned tarball'
[ -f /tmp/pipulse-mv-window.log ] && [ ! -s /tmp/pipulse-mv-window.log ] && ok 'the tree is root-owned and has no setuid file when it is moved into /opt/pipulse' || bad "the tree moved into /opt/pipulse was not root-owned: $(head -n 2 /tmp/pipulse-mv-window.log 2>/dev/null)"
[ -z "$(find /opt/pipulse \( -not -user root -o -not -group root \) 2>/dev/null)" ] && ok 'everything in /opt/pipulse belongs to root, whatever the archive said' || bad 'something in /opt/pipulse is not root-owned'
[ -z "$(find /opt/pipulse -perm /6000 2>/dev/null)" ] && ok 'no setuid or setgid file survives the extraction' || bad 'a setuid file survived the extraction'
# Members that would escape the extraction folder are refused before anything is extracted.
mkdir -p "$out/escape/pipulse-0.0.0-test" && cp -R "$out/hostile/pipulse-0.0.0-test/." "$out/escape/pipulse-0.0.0-test/"
(cd "$out/escape/pipulse-0.0.0-test" && ln -s ../../../../../tmp/pipulse-escape evil-link) || true
tar --absolute-names -czf "$out/pipulse-0.0.0-escape.tar.gz" -C "$out/escape" pipulse-0.0.0-test "$out/escape/pipulse-0.0.0-test/version.json" 2>/dev/null || true
if sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.0-escape.tar.gz" --no-start >/dev/null 2>&1; then bad 'a tarball with an absolute path was accepted'; else ok 'a tarball with an absolute member path is refused'; fi
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.0-test.tar.gz" --no-start >/dev/null || bad 'reinstall for the checks below'
# The pipulse command reads pipulse.env as data, as systemd does: a value with $ or backticks
# runs nothing, quotes are dropped once, the last line wins.
sed -n '/^load_env()/,/^}/p' "$repo/packaging/pipulse" > "$out/load_env.sh"
cat > "$out/test.env" <<'ENV'
# a comment
PIPULSE_PORT=8889
QUOTED="a b"
SINGLE='x y'
HOSTILE=a$(touch /tmp/pipulse-pwned-1)b`touch /tmp/pipulse-pwned-2`c;touch /tmp/pipulse-pwned-3
LAST=1
LAST=2
export EXPORTED=1
9BAD=1
ENV
rm -f /tmp/pipulse-pwned-*
got=$(env -i PATH="$PATH" sh -c "env='$out/test.env'; . '$out/load_env.sh'; load_env; printf '%s|%s|%s|%s|%s|%s' \"\$PIPULSE_PORT\" \"\$QUOTED\" \"\$SINGLE\" \"\$HOSTILE\" \"\$LAST\" \"\${EXPORTED:-unset}\"")
# shellcheck disable=SC2016 # the dollar signs and backticks are the point
want='8889|a b|x y|a$(touch /tmp/pipulse-pwned-1)b`touch /tmp/pipulse-pwned-2`c;touch /tmp/pipulse-pwned-3|2|unset'
[ "$got" = "$want" ] && [ -z "$(ls /tmp/pipulse-pwned-* 2>/dev/null)" ] && ok 'pipulse.env is read as data: nothing in a value runs, quotes and the last line follow systemd' || bad "pipulse.env was not read as data: $got"
# Start it the way the unit would and check it answers.
su -s /bin/sh pipulse -c 'cd /var/lib/pipulse && PIPULSE_DB_PATH=/var/lib/pipulse/pipulse.sqlite PIPULSE_PORT=18888 PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist /opt/pipulse/node/bin/node --disable-warning=ExperimentalWarning /opt/pipulse/app/packages/api/dist/server.js' & pid=$!
# A fresh install serves HTTPS with the CA it made (the certificate names localhost).
for _ in $(seq 1 30); do curl -fs --cacert /etc/pipulse/tls/ca.crt https://localhost:18888/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fs --cacert /etc/pipulse/tls/ca.crt https://localhost:18888/api/config | grep -q '"version":"0.0.0-test"' && ok 'serves the stamped version' || bad 'serves the stamped version'
kill $pid; wait $pid 2>/dev/null || true
# The renewal timer's "enabled once" marker (setup.sh writes it on systemd hosts).
touch /etc/pipulse/.renew-timer-enabled
mkdir -p /etc/systemd/system /var/lib/pipulse-updates /run/systemd/system /tmp/fake-systemctl
printf '#!/bin/sh\nexit 0\n' > /tmp/fake-systemctl/systemctl && chmod +x /tmp/fake-systemctl/systemctl
: > /etc/systemd/system/pipulse-upgrade.service
: > /etc/systemd/system/pipulse-upgrade.path
PATH="/tmp/fake-systemctl:$PATH" sh "$repo/packaging/install.sh" --uninstall
[ ! -e /etc/systemd/system/pipulse-upgrade.service ] && [ ! -e /etc/systemd/system/pipulse-upgrade.path ] && [ ! -e /var/lib/pipulse-updates ] && ok 'uninstall removes the upgrade helper units and its log' || bad 'uninstall removes the upgrade helper units and its log'
rm -rf /run/systemd/system
[ ! -e /etc/pipulse/.renew-timer-enabled ] && ok 'uninstall forgets the timer marker, so a reinstall enables the timer' || bad 'uninstall forgets the timer marker, so a reinstall enables the timer'
[ ! -e /opt/pipulse ] && [ -d /var/lib/pipulse ] && [ -f /etc/pipulse/pipulse.env ] && ok 'uninstall keeps data and settings' || bad 'uninstall keeps data and settings'
# A database the operator put somewhere else is not deleted by a purge, and the purge says so.
mkdir -p /srv/pipulse-data && echo data > /srv/pipulse-data/own.sqlite
echo 'PIPULSE_DB_PATH=/srv/pipulse-data/own.sqlite' >> /etc/pipulse/pipulse.env
mkdir -p /var/lib/pipulse-tarball-backup
sh "$repo/packaging/install.sh" --purge > "$out/purge.log" 2>&1
[ -f /srv/pipulse-data/own.sqlite ] && grep -q 'left in place: /srv/pipulse-data/own.sqlite' "$out/purge.log" && grep -q 'left in place: /var/lib/pipulse-tarball-backup' "$out/purge.log" && ok 'purge leaves a database of your own and an interrupted-move backup, and says so' || bad 'purge did not report what it left'
rm -rf /srv/pipulse-data /var/lib/pipulse-tarball-backup
! getent passwd pipulse >/dev/null && [ ! -e /var/lib/pipulse ] && [ ! -e /etc/pipulse ] && ok 'purge removes everything' || bad 'purge removes everything'
exit $fail
