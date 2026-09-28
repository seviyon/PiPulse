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
  fi
  echo "$was_enabled $was_active" > "$ASIDE/state"
  if [ -d /opt/pipulse ]; then mv /opt/pipulse "$ASIDE/opt"; fi
  if [ -e /usr/bin/pipulse ]; then mv /usr/bin/pipulse "$ASIDE/pipulse"; fi
  if [ -e /etc/systemd/system/pipulse.service ]; then mv /etc/systemd/system/pipulse.service "$ASIDE/pipulse.service"; fi
  if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
}

restore_tarball() {
  rm -rf /opt/pipulse
  if [ -d "$ASIDE/opt" ]; then mv "$ASIDE/opt" /opt/pipulse; fi
  if [ -e "$ASIDE/pipulse" ]; then mv "$ASIDE/pipulse" /usr/bin/pipulse; fi
  if [ -e "$ASIDE/pipulse.service" ]; then mv "$ASIDE/pipulse.service" /etc/systemd/system/pipulse.service; fi
  read -r was_enabled was_active < "$ASIDE/state" || true
  if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
    if [ "${was_enabled:-no}" = yes ]; then systemctl enable pipulse >/dev/null 2>&1 || true; fi
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

health_ok() {
  url=${PIPULSE_HEALTH_URL:-}
  if [ -z "$url" ]; then
    port=$(env_value PIPULSE_PORT)
    host=$(env_value PIPULSE_HOST)
    case ${host:-0.0.0.0} in 0.0.0.0 | '::' | '[::]') host=127.0.0.1 ;; esac
    url="http://$host:${port:-8888}/api/health"
  fi
  i=0
  while [ "$i" -lt "${PIPULSE_HEALTH_WAIT:-30}" ]; do
    curl -fs --max-time 3 "$url" >/dev/null 2>&1 && return 0
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
    sh /opt/pipulse/app/packaging/setup.sh --no-start
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
  if [ "$no_start" = yes ]; then
    sh /opt/pipulse/app/packaging/setup.sh --no-start
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
  [ "$had_previous" = yes ] || die 'PiPulse did not become healthy; see: journalctl -u pipulse'
  failed=$(installed)
  log "$failed did not become healthy: rolling back"
  stop_service
  restore_db
  rm -rf /opt/pipulse/app /opt/pipulse/node
  mv /opt/pipulse/app.previous /opt/pipulse/app
  mv /opt/pipulse/node.previous /opt/pipulse/node
  install -m 755 /opt/pipulse/app/packaging/pipulse /usr/bin/pipulse
  # The previous version's own setup puts its unit file back too.
  start_service no
  if health_ok; then die "$failed did not become healthy; rolled back to $(installed), which is running"; fi
  die "$failed did not become healthy; rolled back to $(installed), but that is not healthy either: see journalctl -u pipulse"
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
    rm -f /etc/systemd/system/pipulse.service
    systemctl daemon-reload
  fi
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
