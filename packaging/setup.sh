#!/bin/sh
# setup.sh [--no-start] [--unit-dir DIR|none] — the one setup both install
# paths run: user, folders, settings file, service, and warnings. Idempotent.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
start=yes unit_dir=/etc/systemd/system
while [ "$#" -gt 0 ]; do
  case $1 in
    --no-start) start=no ;;
    --unit-dir) unit_dir=$2; shift ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || die 'run as root'

# 1. User
if ! getent passwd pipulse >/dev/null; then
  adduser --system --group --home /var/lib/pipulse --no-create-home --shell /usr/sbin/nologin pipulse >/dev/null
fi
if getent group video >/dev/null; then adduser pipulse video >/dev/null; fi

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
  if [ "$unit_dir" != none ]; then install -m 644 "$here/pipulse.service" "$unit_dir/pipulse.service"; fi
  systemctl daemon-reload
  systemctl enable pipulse >/dev/null 2>&1
  systemctl restart pipulse
  log 'service enabled and started'
else
  log 'no systemd running (or --no-start): service not started'
fi

# 5. Warnings (never change anything)
port=$(sed -n 's/^PIPULSE_PORT=\([0-9]*\).*/\1/p' /etc/pipulse/pipulse.env | tail -n 1)
port=${port:-8888}
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
