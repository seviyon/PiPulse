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
APT_URL=https://seviyon.github.io/PiPulse/apt

log() { printf '[pipulse] %s\n' "$*"; }
die() { printf '[pipulse] error: %s\n' "$*" >&2; exit 1; }

install_apt() {
  command -v apt-get >/dev/null 2>&1 || die 'no apt here: use --tarball'
  log 'adding the PiPulse apt repository'
  curl -fsSL "$APT_URL/pipulse.gpg" -o /usr/share/keyrings/pipulse.gpg
  echo "deb [signed-by=/usr/share/keyrings/pipulse.gpg] $APT_URL stable main" > /etc/apt/sources.list.d/pipulse.list
  apt-get update -qq
  apt-get install -y pipulse
  log 'installed; upgrades now come with: sudo apt upgrade'
}

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
    port=$(sed -n 's/^PIPULSE_PORT=\([0-9]*\).*/\1/p' /etc/pipulse/pipulse.env 2>/dev/null | tail -n 1)
    host=$(sed -n 's/^PIPULSE_HOST=\(.*\)/\1/p' /etc/pipulse/pipulse.env 2>/dev/null | tail -n 1)
    case ${host:-0.0.0.0} in 0.0.0.0 | '::' | '[::]') host=127.0.0.1 ;; esac
    url="http://$host:${port:-8888}/api/health"
  fi
  i=0
  while [ "$i" -lt "${PIPULSE_HEALTH_WAIT:-30}" ]; do
    curl -fs "$url" >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 1
  done
  return 1
}

restart() { sh -c "${PIPULSE_RESTART_CMD:-systemctl restart pipulse}"; }

# The installed release, e.g. 0.6.0.
installed() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/pipulse/app/version.json; }

install_tarball() { # install_tarball FILE NO_START
  tarball=$1 no_start=$2
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  tar -xzf "$tarball" -C "$work"
  src=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'pipulse-*' | head -n 1)
  [ -n "$src" ] || die "$tarball is not a PiPulse release tarball"
  arch=$(PIPULSE_NODE_VERSIONS="$src/packaging/node-versions.json" sh -c ". '$src/packaging/lib.sh'; pipulse_arch")
  sh "$src/packaging/fetch-node.sh" "$arch" "$work/staged"
  mkdir -p /opt/pipulse
  rm -rf /opt/pipulse/app.new /opt/pipulse/node.new /opt/pipulse/app.previous /opt/pipulse/node.previous
  mv "$src" /opt/pipulse/app.new
  mv "$work/staged/node" /opt/pipulse/node.new
  had_previous=no
  if [ -d /opt/pipulse/app ]; then
    mv /opt/pipulse/app /opt/pipulse/app.previous
    mv /opt/pipulse/node /opt/pipulse/node.previous
    had_previous=yes
  fi
  mv /opt/pipulse/app.new /opt/pipulse/app
  mv /opt/pipulse/node.new /opt/pipulse/node
  chown -R root:root /opt/pipulse
  install -m 755 /opt/pipulse/app/packaging/pipulse /usr/bin/pipulse
  if [ "$no_start" = yes ]; then
    sh /opt/pipulse/app/packaging/setup.sh --no-start
  elif [ -n "${PIPULSE_FORCE_RESTART:-}" ]; then
    sh /opt/pipulse/app/packaging/setup.sh --no-start
    restart
  else
    [ -d /run/systemd/system ] || die 'systemd is not running: use --no-start'
    sh /opt/pipulse/app/packaging/setup.sh
  fi
  if [ "$no_start" = yes ]; then
    rm -rf /opt/pipulse/app.previous /opt/pipulse/node.previous
    log "installed $(installed) (not started)"
    return 0
  fi
  if health_ok; then
    rm -rf /opt/pipulse/app.previous /opt/pipulse/node.previous
    log "running $(installed)"
    return 0
  fi
  if [ "$had_previous" = yes ]; then
    log 'the new version did not become healthy: rolling back'
    rm -rf /opt/pipulse/app /opt/pipulse/node
    mv /opt/pipulse/app.previous /opt/pipulse/app
    mv /opt/pipulse/node.previous /opt/pipulse/node
    install -m 755 /opt/pipulse/app/packaging/pipulse /usr/bin/pipulse
    restart
    die "rolled back; still running $(installed)"
  fi
  die 'PiPulse did not become healthy; see: journalctl -u pipulse'
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
    uninstall) uninstall no ;;
    purge) uninstall yes ;;
    tarball)
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
