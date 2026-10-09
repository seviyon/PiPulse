#!/bin/sh
# PiPulse installer.
#   curl -fsSL https://github.com/seviyon/PiPulse/releases/latest/download/install.sh | sudo sh
# Default: add PiPulse's signed apt repository and `apt-get install pipulse`.
# --tarball [--version X.Y.Z] | --from FILE   install from a release tarball instead
# --no-start                                  install without starting the service
# --uninstall | --purge                       remove a tarball install (purge: data too)
# Everything is inside main(), called on the last line, so a truncated download runs nothing.
set -eu
REPO=seviyon/PiPulse
# PIPULSE_APT_URL is for tests only (a local repository).
APT_URL=${PIPULSE_APT_URL:-https://seviyon.github.io/PiPulse/apt}

log() { printf '[pipulse] %s\n' "$*"; }
die() { printf '[pipulse] error: %s\n' "$*" >&2; exit 1; }

install_apt() {
  command -v apt-get >/dev/null 2>&1 || die 'no apt here: use --tarball'
  [ "$(uname -m)" != armv6l ] || die 'this Pi (armv6) is not supported: Node 22 has no official build for it'

  # What is already here, so a failure can put it back: a Pi installed from apt
  # may run the one-liner again.
  saved=$(mktemp -d)
  had_source=no was_installed=no
  if [ -e /etc/apt/sources.list.d/pipulse.list ] || [ -e /usr/share/keyrings/pipulse.gpg ]; then
    had_source=yes
    if [ -e /etc/apt/sources.list.d/pipulse.list ]; then cp -p /etc/apt/sources.list.d/pipulse.list "$saved/list"; fi
    if [ -e /usr/share/keyrings/pipulse.gpg ]; then cp -p /usr/share/keyrings/pipulse.gpg "$saved/key"; fi
  fi
  if dpkg-query -W -f='${Status}' pipulse 2>/dev/null | grep -q 'install ok installed'; then was_installed=yes; fi

  # 1. Reach and verify the repository, and download the package, before changing
  #    anything an existing install depends on.
  log 'adding the PiPulse apt repository'
  key=$(mktemp)
  curl -fsSL "$APT_URL/pipulse.gpg" -o "$key" || { rm -rf "$key" "$saved"; die "could not download the repository key from $APT_URL; nothing was changed"; }
  install -m 644 "$key" /usr/share/keyrings/pipulse.gpg
  rm -f "$key"
  echo "deb [signed-by=/usr/share/keyrings/pipulse.gpg] $APT_URL stable main" > /etc/apt/sources.list.d/pipulse.list
  if ! apt-get update -qq || ! apt-get install -y -qq --download-only pipulse </dev/null; then
    restore_apt_source
    die "the PiPulse apt repository at $APT_URL could not be used; nothing was changed"
  fi

  # 2. A tarball install is moved aside, not deleted, until the package is in.
  moved=no
  if tarball_installed; then
    log 'moving the tarball install to apt (settings and data are kept)'
    set_aside_tarball
    moved=yes
  fi

  # 3. Install. Never prompt (stdin is the curl pipe): keep an existing pipulse.env.
  # PIPULSE_TLS_INIT_SUBNET (from ask_subnet) reaches setup.sh through dpkg's environment.
  if ! DEBIAN_FRONTEND=noninteractive apt-get install -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold pipulse </dev/null; then
    restore_apt_source
    if [ "$was_installed" = yes ]; then
      # An upgrade of a working install: never remove it. dpkg keeps its state for
      # `sudo apt-get -f install` (or the next apt upgrade) to finish or retry.
      die 'upgrading the package failed; PiPulse was left installed: see the output above, then run: sudo apt-get -f install'
    fi
    # Remove, never purge: purging runs postrm's clean-up, which deletes /etc/pipulse
    # and the data. Removing keeps them (and pipulse.env, a conffile).
    dpkg --remove --force-remove-reinstreq pipulse >/dev/null 2>&1 || true
    if [ "$moved" = yes ]; then
      restore_tarball
      die 'installing the package failed; the tarball install was put back as it was'
    fi
    die 'installing the package failed'
  fi
  rm -rf "$saved"
  if [ "$moved" = yes ]; then drop_tarball_backup; fi
  log 'installed; upgrades now come with: sudo apt upgrade'
}

# Puts the apt source and key back as they were before this run (or removes them
# if this run added them).
restore_apt_source() {
  rm -f /etc/apt/sources.list.d/pipulse.list /usr/share/keyrings/pipulse.gpg
  if [ "$had_source" = yes ]; then
    if [ -e "$saved/list" ]; then cp -p "$saved/list" /etc/apt/sources.list.d/pipulse.list; fi
    if [ -e "$saved/key" ]; then cp -p "$saved/key" /usr/share/keyrings/pipulse.gpg; fi
  fi
  rm -rf "$saved"
}

# A tarball install: PiPulse files dpkg doesn't own.
tarball_installed() {
  [ -d /opt/pipulse ] || [ -e /etc/systemd/system/pipulse.service ] || return 1
  ! dpkg-query -W -f='${Status}' pipulse 2>/dev/null | grep -q 'install ok installed'
}

# Moves the tarball's app, command and unit (which would shadow the packaged one)
# aside, remembering whether the service was enabled and running. /etc/pipulse and
# the data stay where they are.
ASIDE=/var/lib/pipulse-tarball-backup
set_aside_tarball() {
  rm -rf "$ASIDE"
  mkdir -p "$ASIDE"
  was_enabled=no was_active=no
  if [ -d /run/systemd/system ]; then
    if systemctl is-enabled pipulse >/dev/null 2>&1; then was_enabled=yes; fi
    if systemctl is-active pipulse >/dev/null 2>&1; then was_active=yes; fi
    systemctl disable --now pipulse >/dev/null 2>&1 || true
    systemctl disable --now pipulse-tls-renew.timer >/dev/null 2>&1 || true
  fi
  echo "$was_enabled $was_active" > "$ASIDE/state"
  if [ -d /opt/pipulse ]; then mv /opt/pipulse "$ASIDE/opt"; fi
  if [ -e /usr/bin/pipulse ]; then mv /usr/bin/pipulse "$ASIDE/pipulse"; fi
  for unit in pipulse.service pipulse-tls-renew.service pipulse-tls-renew.timer; do
    if [ -e "/etc/systemd/system/$unit" ]; then mv "/etc/systemd/system/$unit" "$ASIDE/$unit"; fi
  done
  # The timer is off now, so the package's setup must enable it again: left in place, this
  # marker reads as "the operator disabled it". Kept aside for a rollback.
  if [ -e /etc/pipulse/.renew-timer-enabled ]; then mv /etc/pipulse/.renew-timer-enabled "$ASIDE/renew-timer-enabled"; fi
  if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
}

restore_tarball() {
  rm -rf /opt/pipulse
  if [ -d "$ASIDE/opt" ]; then mv "$ASIDE/opt" /opt/pipulse; fi
  if [ -e "$ASIDE/pipulse" ]; then mv "$ASIDE/pipulse" /usr/bin/pipulse; fi
  # The failed new version's units go first; the old version may have had none of the renewal ones.
  if [ -d /run/systemd/system ]; then systemctl disable --now pipulse-tls-renew.timer >/dev/null 2>&1 || true; fi
  for unit in pipulse.service pipulse-tls-renew.service pipulse-tls-renew.timer; do
    rm -f "/etc/systemd/system/$unit"
    if [ -e "$ASIDE/$unit" ]; then mv "$ASIDE/$unit" "/etc/systemd/system/$unit"; fi
  done
  # The failed package may have written its own marker; the old install's is what counts.
  rm -f /etc/pipulse/.renew-timer-enabled
  if [ -e "$ASIDE/renew-timer-enabled" ]; then mv "$ASIDE/renew-timer-enabled" /etc/pipulse/.renew-timer-enabled; fi
  read -r was_enabled was_active < "$ASIDE/state" || true
  if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
    if [ "${was_enabled:-no}" = yes ]; then
      systemctl enable pipulse >/dev/null 2>&1 || true
      if [ -e /etc/systemd/system/pipulse-tls-renew.timer ]; then
        systemctl enable --now pipulse-tls-renew.timer >/dev/null 2>&1 || true
      fi
    fi
    if [ "${was_active:-no}" = yes ]; then systemctl start pipulse || true; fi
  fi
  rm -rf "$ASIDE"
}

drop_tarball_backup() { rm -rf "$ASIDE"; }

fetch_release() { # fetch_release VERSION DIR → DIR/pipulse-VERSION.tar.gz, checked
  base="https://github.com/$REPO/releases/download/v$1"
  curl -fsSL -o "$2/pipulse-$1.tar.gz" "$base/pipulse-$1.tar.gz"
  curl -fsSL -o "$2/SHA256SUMS" "$base/SHA256SUMS"
  (cd "$2" && grep " pipulse-$1.tar.gz\$" SHA256SUMS | sha256sum -c --quiet -) || die "pipulse-$1.tar.gz does not match SHA256SUMS"
}

latest_version() {
  curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's|.*/v||'
}

# HEALTH_MSG keeps the shared check's last reason (its stderr) for the messages below.
HEALTH_MSG=
health_ok() {
  HEALTH_MSG=
  url=${PIPULSE_HEALTH_URL:-}
  check=/opt/pipulse/app/packages/tls/dist/health-check.js
  i=0
  while [ "$i" -lt "${PIPULSE_HEALTH_WAIT:-30}" ]; do
    if [ -z "$url" ] && [ -f "$check" ]; then
      # The installed version's own check: HTTP or verified HTTPS, as the server resolves it.
      # Only the settings it reads, each through env_value: pipulse.env is data here,
      # never sourced as shell code.
      rc=0
      msg=$(env -i PATH="$PATH" \
        PIPULSE_HOST="$(env_value PIPULSE_HOST)" \
        PIPULSE_PORT="$(env_value PIPULSE_PORT)" \
        PIPULSE_TLS="$(env_value PIPULSE_TLS)" \
        PIPULSE_TLS_DIR="$(env_value PIPULSE_TLS_DIR)" \
        PIPULSE_TLS_CERT="$(env_value PIPULSE_TLS_CERT)" \
        PIPULSE_TLS_KEY="$(env_value PIPULSE_TLS_KEY)" \
        PIPULSE_TLS_CA="$(env_value PIPULSE_TLS_CA)" \
        PIPULSE_TLS_NAMES="$(env_value PIPULSE_TLS_NAMES)" \
        /opt/pipulse/node/bin/node "$check" 2>&1 >/dev/null) || rc=$?
      [ "$rc" -eq 0 ] && return 0
      msg=${msg#'[pipulse] health check: '}
      HEALTH_MSG=$msg
      if [ "$rc" -eq 2 ]; then
        # The previous version would serve the same certificate: rolling back can't fix it.
        log "warning: PiPulse is running, but its HTTPS certificate failed verification; not rolling back"
        [ -z "$msg" ] || log "reason: $msg"
        log "see: Settings → Certificate, and journalctl -u pipulse"
        return 0
      fi
    else
      # A pre-6b version (no shared check) or an explicit PIPULSE_HEALTH_URL.
      if [ -z "$url" ]; then
        port=$(env_value PIPULSE_PORT)
        host=$(env_value PIPULSE_HOST)
        case ${host:-0.0.0.0} in 0.0.0.0 | '::' | '[::]') host=127.0.0.1 ;; esac
        u="http://$host:${port:-8889}/api/health"
      else
        u=$url
      fi
      # PiPulse's own answer, not just any 200: another server on the port
      # (RPi-Monitor answers every path) must not pass for a healthy PiPulse.
      curl -fs --max-time 3 "$u" 2>/dev/null | grep -qE '"monitoring":"ok"|"status":"ok"' && return 0
    fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

# A setting from pipulse.env as systemd reads it (last line, quotes removed).
# (Same as lib.sh's: this script must work alone when piped from curl.)
env_value() {
  sed -n "s/^$1=//p" /etc/pipulse/pipulse.env 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

restart() { sh -c "${PIPULSE_RESTART_CMD:-systemctl restart pipulse}"; }

# The installed release, e.g. 0.6.0.
installed() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/pipulse/app/version.json; }

db_path() { v=$(env_value PIPULSE_DB_PATH); echo "${v:-/var/lib/pipulse/pipulse.sqlite}"; }

# The database (and its WAL files) as it was before an upgrade: a new version may
# migrate it, and the previous version then refuses a newer schema.
backup_db() {
  db=$(db_path)
  for f in "$db" "$db-wal" "$db-shm"; do
    rm -f "$f.pre-upgrade"
    if [ -e "$f" ]; then cp -p "$f" "$f.pre-upgrade"; fi
  done
}
restore_db() {
  db=$(db_path)
  [ -e "$db.pre-upgrade" ] || return 0
  for f in "$db" "$db-wal" "$db-shm"; do
    rm -f "$f"
    if [ -e "$f.pre-upgrade" ]; then mv "$f.pre-upgrade" "$f"; fi
  done
}
drop_db_backup() { db=$(db_path); rm -f "$db.pre-upgrade" "$db-wal.pre-upgrade" "$db-shm.pre-upgrade"; }

stop_service() { sh -c "${PIPULSE_STOP_CMD:-systemctl stop pipulse}" >/dev/null 2>&1 || true; }

# Runs setup and (re)starts the service. FIRST is yes on a first install.
start_service() {
  if [ -n "${PIPULSE_FORCE_RESTART:-}" ]; then # tests without systemd
    if [ "$1" = yes ]; then
      sh /opt/pipulse/app/packaging/setup.sh --no-start --first-install
    else
      sh /opt/pipulse/app/packaging/setup.sh --no-start
    fi
    restart
  elif [ "$1" = yes ]; then
    sh /opt/pipulse/app/packaging/setup.sh --first-install
  else
    sh /opt/pipulse/app/packaging/setup.sh
  fi
}

# Whether the service is meant to run (an operator may have disabled or masked it).
service_wanted() {
  [ -n "${PIPULSE_FORCE_RESTART:-}" ] || [ "$(systemctl is-enabled pipulse 2>/dev/null || true)" = enabled ]
}

install_tarball() { # install_tarball FILE NO_START
  tarball=$1 no_start=$2
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  tar -xzf "$tarball" -C "$work"
  src=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'pipulse-*' | head -n 1)
  [ -n "$src" ] || die "$tarball is not a PiPulse release tarball"
  arch=$(PIPULSE_NODE_VERSIONS="$src/packaging/node-versions.json" sh -c ". '$src/packaging/lib.sh'; pipulse_arch")
  sh "$src/packaging/fetch-node.sh" "$arch" "$work/staged"
  if [ "$no_start" = no ] && [ -z "${PIPULSE_FORCE_RESTART:-}" ]; then
    [ -d /run/systemd/system ] || die 'systemd is not running: use --no-start'
  fi
  mkdir -p /opt/pipulse
  # A fresh install stays fresh until setup has made HTTPS work (setup removes this), so a
  # retry after any failure is never taken for an upgrade that stays on plain HTTP.
  pending=/etc/pipulse/.first-install-pending
  if [ ! -d /opt/pipulse/app ] && [ ! -e "$(db_path)" ] && [ ! -e /etc/pipulse/tls ]; then
    install -d -m 750 /etc/pipulse
    (umask 077 && : > "$pending")
  fi
  rm -rf /opt/pipulse/app.new /opt/pipulse/node.new /opt/pipulse/app.previous /opt/pipulse/node.previous
  mv "$src" /opt/pipulse/app.new
  mv "$work/staged/node" /opt/pipulse/node.new
  had_previous=no
  if [ -d /opt/pipulse/app ]; then
    had_previous=yes
    if [ "$no_start" = no ]; then
      stop_service
      backup_db
    fi
    mv /opt/pipulse/app /opt/pipulse/app.previous
    mv /opt/pipulse/node /opt/pipulse/node.previous
  fi
  mv /opt/pipulse/app.new /opt/pipulse/app
  mv /opt/pipulse/node.new /opt/pipulse/node
  chown -R root:root /opt/pipulse
  install -m 755 /opt/pipulse/app/packaging/pipulse /usr/bin/pipulse
  first=yes
  [ "$had_previous" = no ] || first=no
  if [ -e "$pending" ]; then first=yes; fi
  if [ "$no_start" = yes ]; then
    if [ "$first" = yes ]; then
      sh /opt/pipulse/app/packaging/setup.sh --no-start --first-install
    else
      sh /opt/pipulse/app/packaging/setup.sh --no-start
    fi
    rm -rf /opt/pipulse/app.previous /opt/pipulse/node.previous
    log "installed $(installed) (not started)"
    return 0
  fi
  start_service "$first"
  if ! service_wanted; then
    rm -rf /opt/pipulse/app.previous /opt/pipulse/node.previous
    drop_db_backup
    log "installed $(installed); the service is not enabled, so it was not started"
    return 0
  fi
  if health_ok; then
    rm -rf /opt/pipulse/app.previous /opt/pipulse/node.previous
    drop_db_backup
    log "running $(installed)"
    return 0
  fi
  # A pending fresh install has nothing good to go back to: its "previous" is a half-made first run.
  if [ "$had_previous" != yes ] || [ -e "$pending" ]; then
    die "PiPulse did not become healthy${HEALTH_MSG:+ ($HEALTH_MSG)}; see: journalctl -u pipulse"
  fi
  failed=$(installed)
  reason=${HEALTH_MSG:+ ($HEALTH_MSG)}
  log "$failed did not become healthy: rolling back"
  stop_service
  restore_db
  rm -rf /opt/pipulse/app /opt/pipulse/node
  mv /opt/pipulse/app.previous /opt/pipulse/app
  mv /opt/pipulse/node.previous /opt/pipulse/node
  install -m 755 /opt/pipulse/app/packaging/pipulse /usr/bin/pipulse
  # A version from before the renewal timer has no `pipulse tls` command, so the failed
  # version's timer would fail every hour against it. Its marker goes too, so a later
  # upgrade enables the timer again.
  if [ ! -e /opt/pipulse/app/packaging/pipulse-tls-renew.timer ]; then
    if [ -d /run/systemd/system ]; then systemctl disable --now pipulse-tls-renew.timer >/dev/null 2>&1 || true; fi
    rm -f /etc/systemd/system/pipulse-tls-renew.service /etc/systemd/system/pipulse-tls-renew.timer /etc/pipulse/.renew-timer-enabled
    if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
  fi
  # The previous version's own setup puts its unit file back too.
  start_service no
  if health_ok; then die "$failed did not become healthy$reason; rolled back to $(installed), which is running"; fi
  die "$failed did not become healthy$reason; rolled back to $(installed), but that is not healthy either: see journalctl -u pipulse"
}

# The tarball commands must not touch an install apt manages.
refuse_over_apt() {
  if dpkg-query -W -f='${Status}' pipulse 2>/dev/null | grep -q 'install ok installed'; then
    die 'PiPulse is installed with apt here: use apt (sudo apt upgrade / apt remove / apt purge)'
  fi
}

uninstall() { # uninstall PURGE
  if [ -d /run/systemd/system ]; then
    systemctl disable --now pipulse >/dev/null 2>&1 || true
    systemctl disable --now pipulse-tls-renew.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/pipulse.service /etc/systemd/system/pipulse-tls-renew.service /etc/systemd/system/pipulse-tls-renew.timer
    systemctl daemon-reload
  fi
  # The timer is gone, so a reinstall over the kept /etc/pipulse must enable it again (setup.sh
  # reads this marker as "the operator already decided").
  rm -f /etc/pipulse/.renew-timer-enabled
  rm -rf /opt/pipulse /usr/bin/pipulse
  if [ "$1" = yes ]; then
    rm -rf /etc/pipulse /var/lib/pipulse
    if getent passwd pipulse >/dev/null; then deluser --system pipulse >/dev/null 2>&1 || userdel pipulse; fi
    getent group pipulse >/dev/null && { delgroup --system pipulse >/dev/null 2>&1 || groupdel pipulse; } || true
    log 'removed PiPulse, its settings and its data'
  else
    log 'removed PiPulse; kept /etc/pipulse and /var/lib/pipulse (use --purge to remove them)'
  fi
}

# network_of 192.168.1.35/24 → 192.168.1.0/24
network_of() {
  echo "$1" | awk -F'[./]' '{ p = $5; ip = (($1 * 256 + $2) * 256 + $3) * 256 + $4; b = 2 ^ (32 - p); n = ip - (ip % b);
    printf "%d.%d.%d.%d/%d\n", int(n / 16777216) % 256, int(n / 65536) % 256, int(n / 256) % 256, n % 256, p }'
}

# The default-route interface's IPv4 network, unless it is a bridge or VPN, or a prefix not worth offering.
candidate_subnet() {
  dev=$(ip -4 route show default 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n 1)
  [ -n "$dev" ] || return 1
  case $dev in docker* | br-* | veth* | tun* | wg*) return 1 ;; esac
  cidr=$(ip -4 -o addr show dev "$dev" scope global 2>/dev/null | awk '{ print $4 }' | head -n 1)
  [ -n "$cidr" ] || return 1
  prefix=${cidr#*/}
  # The CLI refuses anything broader than a /16, so offering one only ends in a retry.
  { [ "$prefix" -ge 16 ] && [ "$prefix" -le 30 ]; } 2>/dev/null || return 1
  network_of "$cidr"
}

# Fresh install with a terminal: offer IP access for the LAN (default No). Never waits without
# a terminal, on an upgrade, or when the operator already chose a subnet.
ask_subnet() {
  [ -z "${PIPULSE_TLS_INIT_SUBNET:-}" ] || return 0
  [ -e /opt/pipulse/app/version.json ] && return 0
  [ -e /etc/pipulse/tls/state.json ] && return 0
  (: </dev/tty) 2>/dev/null || return 0
  cidr=$(candidate_subnet) || return 0
  cat >/dev/tty <<EOF

[pipulse] HTTPS: PiPulse makes its own certificate authority (CA) for this Pi.
By default it covers the Pi's names ($(hostname), $(hostname).local, localhost), not IP addresses.

This CA will be trusted for the following DNS names and IP ranges. Anyone holding its private key can impersonate hosts within those ranges.

Accepting $cidr allows this CA to issue certificates for any IP in that subnet. A stolen CA key could impersonate other devices there.

EOF
  printf 'Also cover https://<IP address> in %s? [y/N] ' "$cidr" >/dev/tty
  answer=
  read -r answer </dev/tty || answer=
  case $answer in
    y | Y | yes | YES) PIPULSE_TLS_INIT_SUBNET=$cidr; export PIPULSE_TLS_INIT_SUBNET ;;
    *) printf '[pipulse] names only; to add it later: sudo pipulse tls new-ca --subnet %s\n' "$cidr" >/dev/tty ;;
  esac
}

# Releases before 0.7.0 make no CA at install and ignore PIPULSE_TLS_INIT_SUBNET, so asking would mislead.
version_makes_ca() { # version_makes_ca X.Y.Z[-rcN]
  echo "${1#v}" | awk -F. '{ exit !(($1 + 0 > 0) || ($1 + 0 == 0 && $2 + 0 >= 7)) }'
}

# The release a tarball holds, from the version.json inside it; nothing if it can't be read.
tarball_version() { # tarball_version FILE
  member=$(tar -tzf "$1" 2>/dev/null | sed -n 's#^\(\./\)\{0,1\}pipulse-[^/]*/version\.json$#&#p' | head -n 1)
  [ -n "$member" ] || return 0
  tar -xzOf "$1" "$member" 2>/dev/null | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' | head -n 1
}

main() {
  mode=apt version='' from='' no_start=no
  while [ "$#" -gt 0 ]; do
    case $1 in
      --tarball) mode=tarball ;;
      --version) version=$2; mode=tarball; shift ;;
      --from) from=$2; mode=tarball; shift ;;
      --no-start) no_start=yes ;;
      --uninstall) mode=uninstall ;;
      --purge) mode=purge ;;
      -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done
  [ "$(id -u)" -eq 0 ] || die 'run as root (sudo)'
  if [ "$mode" = apt ] || [ "$mode" = tarball ]; then
    # A local tarball says which release it is; if it doesn't, don't ask about an option it may ignore.
    ask=yes
    if [ -n "$from" ] && [ -z "$version" ]; then
      version=$(tarball_version "$from")
      [ -n "$version" ] || ask=no
    fi
    if [ "$no_start" != yes ] && [ "$ask" = yes ] && { [ -z "$version" ] || version_makes_ca "$version"; }; then ask_subnet; fi
  fi
  case $mode in
    apt) install_apt ;;
    uninstall) refuse_over_apt; uninstall no ;;
    purge) refuse_over_apt; uninstall yes ;;
    tarball)
      refuse_over_apt
      if [ -z "$from" ]; then
        dl=$(mktemp -d)
        version=${version:-$(latest_version)}
        fetch_release "$version" "$dl"
        from="$dl/pipulse-$version.tar.gz"
      fi
      install_tarball "$from" "$no_start" ;;
  esac
}

main "$@"
