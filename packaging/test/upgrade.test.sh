#!/bin/sh
# pipulse-upgrade.sh, the root helper behind the Updates tab's "Install updates" button: real
# apt-get against a throw-away local repository. It must ignore every request that is not
# exactly a fresh doorbell from the pipulse user on an install whose root-owned settings allow it.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
helper="$here/pipulse-upgrade.sh"
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
check() { # check DESCRIPTION CONDITION...
  d=$1; shift
  if "$@"; then ok "$d"; else bad "$d"; fi
}

REQ=/var/lib/pipulse/upgrade-request
OUT=/var/lib/pipulse-updates
export DEBIAN_FRONTEND=noninteractive

# --- the machine: the pipulse user, its settings, and a repository with fake package versions
install -d /var/lib/pipulse
getent passwd pipulse >/dev/null || adduser --system --group --home /var/lib/pipulse --no-create-home pipulse >/dev/null
rm -rf /etc/pipulse "$OUT" /var/lib/pipulse /run/pipulse-upgrade.lock
install -d -o root -g pipulse -m 750 /etc/pipulse
install -d -o pipulse -g pipulse -m 700 /var/lib/pipulse
: > /etc/pipulse/admin.hash

build() { # build VERSION POSTINST-BODY CONF-LINE
  b=$(mktemp -d)
  mkdir -p "$b/DEBIAN" "$b/etc"
  printf 'Package: pipulse-fakepkg\nVersion: %s\nArchitecture: all\nMaintainer: t <t@example.com>\nDescription: test package\n' "$1" > "$b/DEBIAN/control"
  printf '%s\n' "$3" > "$b/etc/pipulse-fakepkg.conf"
  echo /etc/pipulse-fakepkg.conf > "$b/DEBIAN/conffiles"
  printf '#!/bin/sh\n%s\nexit 0\n' "$2" > "$b/DEBIAN/postinst"
  chmod 755 "$b/DEBIAN/postinst"
  dpkg-deb -Zgzip --root-owner-group --build "$b" "/repo-apt/pipulse-fakepkg_$1_all.deb" >/dev/null
  rm -rf "$b"
}
index() {
  (cd /repo-apt && {
    for f in *.deb; do
      dpkg-deb -f "$f"
      echo "Filename: ./$f"
      echo "Size: $(wc -c < "$f")"
      echo "SHA256: $(sha256sum "$f" | cut -d' ' -f1)"
      echo
    done > Packages
  })
  chmod -R a+rX /repo-apt
}
mkdir -p /repo-apt
rm -f /repo-apt/*
mkdir -p /etc/apt/disabled-sources
mv /etc/apt/sources.list.d/* /etc/apt/disabled-sources/ 2>/dev/null || true
mv /etc/apt/sources.list /etc/apt/disabled-sources/ 2>/dev/null || true
echo 'deb [trusted=yes] file:/repo-apt ./' > /etc/apt/sources.list.d/test.list

build 1.0 'true' 'one'
index
apt-get update >/dev/null 2>&1
apt-get install -y pipulse-fakepkg >/dev/null 2>&1
installed() { dpkg-query -W -f='${Version}' pipulse-fakepkg; }
[ "$(installed)" = 1.0 ] || { echo 'cannot set up the fake package'; exit 1; }
# Version 2: a new conffile, a postinst that prints, and a new line apt would ask about.
echo 'edited by the operator' > /etc/pipulse-fakepkg.conf
build 2.0 'echo "Setting up the fake package 2.0"' 'two'
index

allow() { printf 'PIPULSE_ALLOW_UPGRADE=true\nPIPULSE_ADMIN_PASSWORD_HASH_FILE=/etc/pipulse/admin.hash\n' > /etc/pipulse/pipulse.env; }
ring() { # ring [AGE-SECONDS] [OWNER]
  rm -rf "$REQ"
  printf 'upgrade\n' > "$REQ"
  chown "${2:-pipulse}" "$REQ"
  [ -z "${1:-}" ] || touch -d "@$(($(date +%s) - $1))" "$REQ"
}
run() { sh "$helper" > /tmp/helper.out 2>&1; }
fresh() { rm -f "$OUT/upgrade-status.json"; } # the cooldown reads the last run's status
status_state() { sed -n 's/^{"state":"\([a-z]*\)".*/\1/p' "$OUT/upgrade-status.json" 2>/dev/null; }

# 1. no request: nothing happens at all
allow
run
check 'no request: exits quietly and leaves no state folder' [ ! -e "$OUT" ]

# 2. the gates
rm -f /etc/pipulse/pipulse.env
ring
run
check 'off by default: the request is deleted and ignored' sh -c "[ ! -e $REQ ] && [ ! -e $OUT ] && [ \$(dpkg-query -W -f='\${Version}' pipulse-fakepkg) = 1.0 ]"
check 'off by default: the journal says why' grep -q 'PIPULSE_ALLOW_UPGRADE is not true' /tmp/helper.out

printf 'PIPULSE_ALLOW_UPGRADE=yes\nPIPULSE_ADMIN_PASSWORD_HASH_FILE=/etc/pipulse/admin.hash\n' > /etc/pipulse/pipulse.env
ring
run
check 'only the exact word true turns it on' sh -c "[ ! -e $OUT ]"

printf 'PIPULSE_ALLOW_UPGRADE=true\n' > /etc/pipulse/pipulse.env
ring
run
check 'allowed but no sign-in configured: ignored' sh -c "[ ! -e $OUT ] && grep -q 'sign-in is not configured' /tmp/helper.out"

printf 'PIPULSE_ALLOW_UPGRADE=true\nPIPULSE_ADMIN_PASSWORD_HASH_FILE=/etc/pipulse/missing.hash\n' > /etc/pipulse/pipulse.env
ring
run
check 'a sign-in hash file that does not exist: ignored' sh -c "[ ! -e $OUT ]"

# 3. the doorbell itself
allow
ring '' root
run
check 'a request not made by the pipulse user is ignored and deleted' sh -c "[ ! -e $REQ ] && [ ! -e $OUT ] && grep -q 'owned by root' /tmp/helper.out"

ring 600
run
check 'an old request is ignored and deleted' sh -c "[ ! -e $REQ ] && [ ! -e $OUT ] && grep -q stale /tmp/helper.out"

ring -3600
run
check 'a request stamped in the future is ignored' sh -c "[ ! -e $OUT ]"

rm -f "$REQ"
head -c 2000 /dev/zero | tr '\0' x > "$REQ"
chown pipulse "$REQ"
run
check 'a big request is ignored' sh -c "[ ! -e $REQ ] && [ ! -e $OUT ] && grep -q 'too big' /tmp/helper.out"

rm -f "$REQ"
echo keep > /tmp/victim
ln -s /tmp/victim "$REQ"
run
check 'a link in place of the request is removed, never followed' sh -c "[ ! -e $REQ ] && [ ! -L $REQ ] && [ \"\$(cat /tmp/victim)\" = keep ] && [ ! -e $OUT ]"

rm -rf "$REQ"
mkdir "$REQ"
run
check 'an empty directory in place of the request is removed' sh -c "[ ! -e $REQ ] && [ ! -e $OUT ]"

# 3b. the sign-in hash file must be a plain, absolute, root-owned file (a compromised server could
# otherwise make one itself)
printf 'PIPULSE_ALLOW_UPGRADE=true\nPIPULSE_ADMIN_PASSWORD_HASH_FILE=admin.hash\n' > /etc/pipulse/pipulse.env
ring
run
check 'a relative hash file path is not sign-in configured' sh -c "[ ! -e $OUT ]"
: > /var/lib/pipulse/own.hash
chown pipulse /var/lib/pipulse/own.hash
printf 'PIPULSE_ALLOW_UPGRADE=true\nPIPULSE_ADMIN_PASSWORD_HASH_FILE=/var/lib/pipulse/own.hash\n' > /etc/pipulse/pipulse.env
ring
run
check 'a hash file the pipulse user owns does not count' sh -c "[ ! -e $OUT ] && grep -q 'owned by root' /tmp/helper.out"
ln -sf /etc/pipulse/admin.hash /var/lib/pipulse/link.hash
printf 'PIPULSE_ALLOW_UPGRADE=true\nPIPULSE_ADMIN_PASSWORD_HASH_FILE=/var/lib/pipulse/link.hash\n' > /etc/pipulse/pipulse.env
ring
run
check 'a link to a hash file does not count' sh -c "[ ! -e $OUT ]"
rm -f /var/lib/pipulse/own.hash /var/lib/pipulse/link.hash
allow

rm -rf "$REQ"
mkdir -p "$REQ/sub"
touch "$REQ/sub/file"
run
check 'a non-empty directory in place of the request is removed too' sh -c "[ ! -e $REQ ] && [ ! -e $OUT ]"

# 4. a good request upgrades the package, keeps the operator's configuration, and says so
ring
run
check 'the request is consumed' [ ! -e "$REQ" ]
check 'a good request upgrades the package' sh -c "[ \$(dpkg-query -W -f='\${Version}' pipulse-fakepkg) = 2.0 ]"
check 'status says done with exit code 0' sh -c "[ \"\$(sed -n 's/^{\"state\":\"\\([a-z]*\\)\".*/\\1/p' $OUT/upgrade-status.json)\" = done ] && grep -q '\"exitCode\":0' $OUT/upgrade-status.json"
check 'status has the step, a start, a finish and the boot id' sh -c "grep -q '\"step\":\"upgrade\"' $OUT/upgrade-status.json && grep -Eq '\"startedAt\":[0-9]+,\"finishedAt\":[0-9]+' $OUT/upgrade-status.json && grep -Eq '\"bootId\":\"[0-9a-f-]+\"' $OUT/upgrade-status.json"
check 'the log shows both steps and the package script output' sh -c "grep -q '== apt-get update' $OUT/upgrade.log && grep -q '== apt-get upgrade' $OUT/upgrade.log && grep -q 'Setting up the fake package 2.0' $OUT/upgrade.log && grep -q '== finished with exit code 0' $OUT/upgrade.log"
check 'the edited configuration file was kept (--force-confold, no prompt)' sh -c "[ \"\$(cat /etc/pipulse-fakepkg.conf)\" = 'edited by the operator' ]"
check 'the log and status are world-readable; the folder is owned by root' sh -c "[ \$(stat -c %a $OUT/upgrade.log) = 644 ] && [ \$(stat -c %a $OUT/upgrade-status.json) = 644 ] && [ \$(stat -c %U:%a $OUT) = root:755 ]"
check 'no temporary status file is left behind' sh -c "[ -z \"\$(ls -A $OUT | grep '^\\.' || true)\" ]"

# 4b. a second request right after an upgrade is declined (cooldown), then allowed once the
# recorded finish is old enough
ring
run
check 'right after an upgrade the next request is declined' grep -q 'less than 10 minutes ago' /tmp/helper.out
sed -i 's/"finishedAt":[0-9]*/"finishedAt":1/' "$OUT/upgrade-status.json"

# 5. a failing step is reported with its step and exit code
rm -f /repo-apt/Packages
ring
run
check 'a failed update is reported as failed, step update' sh -c "[ \"\$(sed -n 's/^{\"state\":\"\\([a-z]*\\)\".*/\\1/p' $OUT/upgrade-status.json)\" = failed ] && grep -q '\"step\":\"update\"' $OUT/upgrade-status.json && grep -Eq '\"exitCode\":[1-9]' $OUT/upgrade-status.json"
check 'the failure is in the log' grep -q '== finished with exit code [1-9]' "$OUT/upgrade.log"

# 6. only the last 200 KB of a long log stay
# shellcheck disable=SC2016 # runs in the package's own script
build 3.0 'i=0; while [ $i -lt 6000 ]; do echo "padding line number $i of the fake package three"; i=$((i + 1)); done' 'three'
index
fresh
ring
run
check 'a long log is cut to its last 200 KB, keeping the end' sh -c "[ \$(wc -c < $OUT/upgrade.log) -le 204800 ] && grep -q '== finished with exit code 0' $OUT/upgrade.log && ! grep -q '== apt-get update' $OUT/upgrade.log"
check 'the lock file is private to root, so the pipulse user cannot hold it' test "$(stat -c %U:%a /run/pipulse-upgrade.lock)" = root:600
check 'version 3 was installed' sh -c "[ \$(dpkg-query -W -f='\${Version}' pipulse-fakepkg) = 3.0 ]"

# 7. one at a time
build 4.0 'true' 'four'
index
fresh
ring
(
  exec 8> /run/pipulse-upgrade.lock
  flock 8
  run
  sleep 0.2
) &
wait
check 'while another upgrade holds the lock the request is declined, not run' sh -c "grep -q 'already running' /tmp/helper.out && [ \$(dpkg-query -W -f='\${Version}' pipulse-fakepkg) = 3.0 ]"
rm -f /run/pipulse-upgrade.lock

# 8. killed half way: the status does not stay "running"
build 5.0 'sleep 30' 'five'
index
fresh
ring
sh "$helper" > /tmp/helper.out 2>&1 &
pid=$!
i=0
while [ "$(status_state)" != running ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.2; done
check 'while it runs, the status says running with no finish time' sh -c "[ \"\$(sed -n 's/^{\"state\":\"\\([a-z]*\\)\".*/\\1/p' $OUT/upgrade-status.json)\" = running ] && grep -q '\"finishedAt\":null' $OUT/upgrade-status.json"
kill -TERM "$pid"
wait "$pid" 2>/dev/null || true
pkill -f 'sleep 30' 2>/dev/null || true
pkill dpkg 2>/dev/null || true
pkill apt-get 2>/dev/null || true
sleep 1
check 'a terminated helper leaves failed, not running' sh -c "[ \"\$(sed -n 's/^{\"state\":\"\\([a-z]*\\)\".*/\\1/p' $OUT/upgrade-status.json)\" = failed ]"
dpkg --configure -a >/dev/null 2>&1 || true

# Leave the container as found: later tests (and the TLS unit tests CI runs afterwards as root)
# expect no pipulse user or group, and the real package sources.
dpkg --purge pipulse-fakepkg >/dev/null 2>&1 || true
rm -rf /etc/pipulse /var/lib/pipulse /var/lib/pipulse-updates /run/pipulse-upgrade.lock /repo-apt /etc/pipulse-fakepkg.conf /tmp/victim
rm -f /etc/apt/sources.list.d/test.list
if [ -e /etc/apt/disabled-sources/sources.list ]; then mv /etc/apt/disabled-sources/sources.list /etc/apt/sources.list; fi
mv /etc/apt/disabled-sources/* /etc/apt/sources.list.d/ 2>/dev/null || true
rmdir /etc/apt/disabled-sources 2>/dev/null || true
userdel pipulse 2>/dev/null || true
groupdel pipulse 2>/dev/null || true
exit $fail
