#!/bin/sh
# pipulse-upgrade.sh — the root helper behind the Updates tab's "Install updates" button.
#
# Started by pipulse-upgrade.path when the (unprivileged) server drops a request file in its own
# data folder. The request is only a doorbell: nothing in it is read, and nothing the server
# controls reaches a command line. What decides is root-owned configuration:
#   - PIPULSE_ALLOW_UPGRADE=true in /etc/pipulse/pipulse.env, and
#   - sign-in configured (PIPULSE_ADMIN_PASSWORD_HASH_FILE names an existing file).
# Without both, the request is deleted and ignored. It runs `apt-get update` and
# `apt-get upgrade` (never full-upgrade, never a removal) and records the output and the result
# in /var/lib/pipulse-updates, which the server only reads.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"

REQUEST=/var/lib/pipulse/upgrade-request
STATE=/var/lib/pipulse-updates
LOG=$STATE/upgrade.log
STATUS=$STATE/upgrade-status.json
LOCK=/run/pipulse-upgrade.lock
LOG_KEEP=204800
# A doorbell older than this was left from before; one stamped in the future is no better.
MAX_AGE=120

# The cooldown between two upgrades: a loop of requests from a compromised server must not keep
# apt's lock busy. Judged from this helper's own (root-owned) status file.
COOLDOWN=600

REASON=
started=0 step=update boot_id=
status_written=no

# request_ok — the request file is a plain file made by the pipulse user, small and fresh.
request_ok() {
  if [ -L "$REQUEST" ] || [ ! -f "$REQUEST" ]; then REASON='not a plain file'; return 1; fi
  meta=$(stat -c '%U %s %Y' "$REQUEST") || { REASON='cannot stat'; return 1; }
  # shellcheck disable=SC2086
  set -- $meta
  [ "$1" = pipulse ] || { REASON="owned by $1"; return 1; }
  [ "$2" -le 1024 ] || { REASON='too big'; return 1; }
  age=$(($(date +%s) - $3))
  if [ "$age" -gt "$MAX_AGE" ] || [ "$age" -lt -5 ]; then REASON='stale'; return 1; fi
  return 0
}

# allowed — the operator turned the button on, and sign-in is configured.
allowed() {
  [ "$(env_value PIPULSE_ALLOW_UPGRADE)" = true ] || { REASON='PIPULSE_ALLOW_UPGRADE is not true'; return 1; }
  hash=$(env_value PIPULSE_ADMIN_PASSWORD_HASH_FILE)
  # An absolute path to a plain file root owns: one the pipulse user could create (a path inside
  # its own data folder, a link) would let a compromised server satisfy this itself.
  case $hash in /*) ;; *) REASON='sign-in is not configured'; return 1 ;; esac
  if [ -L "$hash" ] || [ ! -f "$hash" ] || [ "$(stat -c %U "$hash")" != root ]; then
    REASON='sign-in is not configured (the password hash file must be a plain file owned by root)'
    return 1
  fi
  return 0
}

# write_status STATE [EXIT] — atomically; the server reads this file.
write_status() {
  finished=null code=null
  if [ "$1" != running ]; then finished=$(date +%s) code=${2:-null}; fi
  tmp=$STATE/.upgrade-status.$$
  printf '{"state":"%s","step":"%s","startedAt":%s,"finishedAt":%s,"exitCode":%s,"bootId":"%s"}\n' \
    "$1" "$step" "$started" "$finished" "$code" "$boot_id" > "$tmp"
  mv -f "$tmp" "$STATUS"
  status_written=yes
}

# trim_log — only the last LOG_KEEP bytes stay.
trim_log() {
  [ "$(wc -c < "$LOG")" -gt "$LOG_KEEP" ] || return 0
  tail -c "$LOG_KEEP" "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
}

# shellcheck disable=SC2329 # runs as the EXIT trap
on_exit() {
  rc=$?
  # Killed or crashed between "running" and the result: say so instead of leaving it running.
  if [ "$status_written" = yes ] && [ "$(sed -n 's/^{"state":"\([a-z]*\)".*/\1/p' "$STATUS" 2>/dev/null)" = running ]; then
    write_status failed "$rc" || true
  fi
}

main() {
  [ "$(id -u)" -eq 0 ] || die 'run as root'
  if [ ! -e "$REQUEST" ] && [ ! -L "$REQUEST" ]; then exit 0; fi
  ok=yes
  request_ok || ok=no
  # Consumed first, valid or not: a bad doorbell must not ring again.
  # (A directory the server made there goes too; rm -r never follows a link.)
  rm -rf --one-file-system -- "$REQUEST" 2>/dev/null || true
  if [ "$ok" = no ]; then log "ignored an upgrade request: $REASON"; exit 0; fi
  allowed || { log "ignored an upgrade request: $REASON"; exit 0; }
  command -v apt-get >/dev/null 2>&1 || { log 'ignored an upgrade request: apt-get is missing'; exit 0; }

  [ ! -L "$STATE" ] || die "$STATE is a link"
  install -d -m 755 -o root -g root "$STATE"
  command -v flock >/dev/null 2>&1 || die 'flock is missing'
  # Root-only, so the pipulse user cannot open it and hold the lock itself.
  (umask 077; : >> "$LOCK")
  chmod 600 "$LOCK"
  exec 9> "$LOCK"
  flock -n 9 || { log 'an upgrade is already running'; exit 0; }

  last=$(sed -n 's/.*"finishedAt":\([0-9][0-9]*\).*/\1/p' "$STATUS" 2>/dev/null || true)
  if [ -n "$last" ] && [ "$(($(date +%s) - last))" -lt "$COOLDOWN" ] && [ "$(($(date +%s) - last))" -ge -5 ]; then
    log "ignored an upgrade request: the last upgrade finished less than $((COOLDOWN / 60)) minutes ago"
    exit 0
  fi
  boot_id=$(tr -cd '0-9a-f-' < /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  started=$(date +%s)
  : > "$LOG"
  chmod 644 "$LOG"
  trap on_exit EXIT
  trap 'exit 143' TERM INT HUP
  write_status running

  export DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none LC_ALL=C
  rc=0
  {
    echo "== apt-get update ($(date -u '+%Y-%m-%d %H:%M:%S') UTC)"
    apt-get -o DPkg::Lock::Timeout=120 update
  } >> "$LOG" 2>&1 < /dev/null || rc=$?
  if [ "$rc" -eq 0 ]; then
    step=upgrade
    {
      echo "== apt-get upgrade ($(date -u '+%Y-%m-%d %H:%M:%S') UTC)"
      apt-get -y -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confold upgrade
    } >> "$LOG" 2>&1 < /dev/null || rc=$?
  fi
  echo "== finished with exit code $rc" >> "$LOG"
  trim_log
  if [ "$rc" -eq 0 ]; then write_status 'done' 0; else write_status failed "$rc"; fi
  exit 0
}

# Wrapped and called last: dpkg may replace this file while apt runs, and sh reads a script
# as it goes.
main "$@"
