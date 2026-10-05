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

# 3b. HTTPS material and mode: made and checked before the service (re)starts; state.json is
#     written last, and an upgrade never switches the transport.
# install.sh leaves this marker on a fresh install until setup succeeds, so a retry after any
# failure is still a first install, never an HTTP "upgrade".
pending=/etc/pipulse/.first-install-pending
if [ -e "$pending" ]; then first=yes; fi
tls_ready=no
tls_cli() {
  n=/opt/pipulse/node/bin/node
  [ -x "$n" ] || n=$(command -v node)
  "$n" --disable-warning=ExperimentalWarning "$here/../packages/tls/dist/cli.js" "$@"
}
# --yes: consent to a subnet came from the installer's prompt or PIPULSE_TLS_SUBNETS.
set -- init --mode auto --yes
if [ "$first" = yes ]; then set -- "$@" --first-install; fi
if [ "$first" = yes ] && [ -n "${PIPULSE_TLS_INIT_SUBNET:-}" ]; then
  set -- "$@" --subnet "$PIPULSE_TLS_INIT_SUBNET"
fi
if tls_cli "$@"; then
  tls_ready=yes
elif [ "$first" = yes ] && [ -n "${PIPULSE_TLS_INIT_SUBNET:-}" ] && tls_cli init --mode auto --yes --first-install; then
  tls_ready=yes
  warn "$PIPULSE_TLS_INIT_SUBNET was not accepted; the CA covers names only (to add a subnet later: sudo pipulse tls new-ca --subnet <cidr>)"
elif [ "$first" = yes ]; then
  die 'HTTPS could not be set up (see above). Fix it and run setup again: sudo sh /opt/pipulse/app/packaging/setup.sh --first-install, or serve plain HTTP: sudo pipulse tls disable --allow-insecure'
fi
port=$(env_value PIPULSE_PORT)
port=${port:-8889}

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
      # Success on a first install is the service answering and, over HTTPS, the server
      # having marked its data (see tls-installed): without the marker, losing the TLS
      # folder later would make this install look like an HTTP one.
      if pipulse_health; then
        db=$(env_value PIPULSE_DB_PATH)
        marker="$(dirname "${db:-/var/lib/pipulse/pipulse.sqlite}")/tls-installed"
        i=0
        while [ ! -e "$marker" ] && [ "$i" -lt 5 ]; do i=$((i + 1)); sleep 1; done
        if grep -q '"https"' /etc/pipulse/tls/state.json 2>/dev/null && [ "$(env_value PIPULSE_TLS)" != off ] && [ ! -e "$marker" ]; then
          printf '[pipulse] error: the server serves HTTPS but could not write %s (see journalctl -u pipulse); fix the data folder, then: sudo sh /opt/pipulse/app/packaging/setup.sh --first-install\n' "$marker" >&2
          exit 1
        fi
        rm -f "$pending"
        if grep -q '"https"' /etc/pipulse/tls/state.json 2>/dev/null && [ "$(env_value PIPULSE_TLS)" != off ]; then
          log "PiPulse is running: https://$(hostname):$port (trust its CA first: sudo pipulse tls export-ca)"
        fi
      else
        printf '[pipulse] error: PiPulse did not come up healthy%s\n' "${HEALTH_MSG:+ ($HEALTH_MSG)}" >&2
        printf '  see: journalctl -u pipulse   and   sudo pipulse tls status\n' >&2
        printf '  retry: sudo sh /opt/pipulse/app/packaging/setup.sh --first-install\n  or serve plain HTTP: sudo pipulse tls disable --allow-insecure\n' >&2
        exit 1
      fi
    else
      warn 'could not enable the pipulse service (masked?); start it with: sudo systemctl enable --now pipulse'
      rm -f "$pending"
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
  # Nothing starts here, so the material made and state.json written are the success gate.
  if [ "$first" = yes ] && [ "$tls_ready" = yes ]; then rm -f "$pending"; fi
fi

# 5. Warnings (never change anything)
command -v openssl >/dev/null 2>&1 || warn 'openssl is not installed; generated HTTPS certificates need it: sudo apt install openssl'
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
