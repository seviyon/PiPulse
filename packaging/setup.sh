#!/bin/sh
# setup.sh [--no-start] [--first-install] [--unit-dir DIR|none] — the one setup
# both install paths run: user, folders, settings file, service, and warnings.
# Idempotent. The service is enabled only on a first install; after that an
# enabled service is restarted and a disabled or masked one is left alone.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
start=yes first=no unit_dir=/etc/systemd/system
warn() { printf '[pipulse] warning: %s\n' "$*" >&2; }
while [ "$#" -gt 0 ]; do
  case $1 in
    --no-start) start=no ;;
    --first-install) first=yes ;;
    --unit-dir) unit_dir=$2; shift ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || die 'run as root'

# 1. User
if ! getent passwd pipulse >/dev/null; then
  # The home folder exists first, or adduser warns it can't be accessed (owner set below).
  install -d -m 700 /var/lib/pipulse
  adduser --system --group --home /var/lib/pipulse --no-create-home --shell /usr/sbin/nologin pipulse >/dev/null
fi
if getent group video >/dev/null && ! id -nG pipulse | grep -qw video; then adduser pipulse video >/dev/null; fi

# 2. Folders
install -d -o root -g pipulse -m 750 /etc/pipulse
install -d -o pipulse -g pipulse -m 700 /var/lib/pipulse

# 3. Settings, only if missing
if [ ! -e /etc/pipulse/pipulse.env ]; then
  install -o root -g pipulse -m 640 "$here/pipulse.env" /etc/pipulse/pipulse.env
fi
# The .deb ships pipulse.env as a conffile owned by root: give the service read access.
chown root:pipulse /etc/pipulse/pipulse.env
chmod 640 /etc/pipulse/pipulse.env

# 4. Service
if [ "$start" = yes ] && [ -d /run/systemd/system ]; then
  if [ "$unit_dir" != none ]; then
    for unit in pipulse.service pipulse-tls-renew.service pipulse-tls-renew.timer; do
      install -m 644 "$here/$unit" "$unit_dir/$unit"
    done
  fi
  systemctl daemon-reload || true
  if [ "$first" = yes ]; then
    if systemctl enable pipulse >/dev/null 2>&1; then
      systemctl restart pipulse
      log 'service enabled and started'
    else
      warn 'could not enable the pipulse service (masked?); start it with: sudo systemctl enable --now pipulse'
    fi
  else
    state=$(systemctl is-enabled pipulse 2>/dev/null || true)
    case $state in
      enabled) systemctl restart pipulse; log 'service restarted' ;;
      masked) warn 'the pipulse service is masked: left as it is, not started' ;;
      *) warn "the pipulse service is ${state:-not enabled}: left as it is, not started (sudo systemctl enable --now pipulse)" ;;
    esac
  fi
  # Hourly check; renews only a generated certificate that is due. Enabled on
  # every install and upgrade unless the operator masked it.
  case $(systemctl is-enabled pipulse-tls-renew.timer 2>/dev/null || true) in
    masked) warn 'pipulse-tls-renew.timer is masked: a generated HTTPS certificate will not renew by itself' ;;
    *) systemctl enable --now pipulse-tls-renew.timer >/dev/null 2>&1 || warn 'could not enable pipulse-tls-renew.timer' ;;
  esac
else
  log 'no systemd running (or --no-start): service not started'
fi

# 5. Warnings (never change anything)
command -v openssl >/dev/null 2>&1 || warn 'openssl is not installed; generated HTTPS certificates need it: sudo apt install openssl'
port=$(env_value PIPULSE_PORT)
port=${port:-8889}
if command -v ss >/dev/null 2>&1; then
  holder=$(ss -Hltnp "sport = :$port" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1)
  if [ -n "$holder" ] && [ "$holder" != node ]; then
    printf '[pipulse] warning: port %s is already in use by %s; set PIPULSE_PORT in /etc/pipulse/pipulse.env\n' "$port" "$holder" >&2
  elif [ -z "$holder" ] && ss -Hltn "sport = :$port" | grep -q .; then
    printf '[pipulse] warning: port %s is already in use; set PIPULSE_PORT in /etc/pipulse/pipulse.env\n' "$port" >&2
  fi
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  if ! ufw status | grep -qE "^$port(/tcp)?[[:space:]]"; then
    printf '[pipulse] warning: ufw is active and has no rule for port %s; to allow your LAN:\n  sudo ufw allow from 192.168.1.0/24 to any port %s proto tcp\n' "$port" "$port" >&2
  fi
fi
