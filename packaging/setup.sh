#!/bin/sh
# setup.sh [--no-start] [--first-install] [--unit-dir DIR|none] — the one setup
# both install paths run: user, folders, settings file, service, and warnings.
# Idempotent. The service is enabled only on a first install; after that an
# enabled service is restarted and a disabled or masked one is left alone. The
# renewal timer is enabled once (first install, or first upgrade that has it).
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
# True when the operator masked the unit (systemd says so, or its file is a link to /dev/null).
unit_masked() {
  [ "$(systemctl is-enabled "$1" 2>/dev/null || true)" = masked ] && return 0
  [ "$unit_dir" != none ] && [ -L "$unit_dir/$1" ] && [ "$(readlink "$unit_dir/$1")" = /dev/null ]
}

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
# An upgrade must never restart into "no mode chosen": the release default stops the server
# then. If init failed before writing state.json (a full disk, a wrong owner), say so and fall
# back to the previous behaviour, plain HTTP, which `sudo pipulse tls enable` can still undo.
tls_dir=$(env_value PIPULSE_TLS_DIR)
tls_dir=${tls_dir:-/etc/pipulse/tls}
served=$(served_marker)
if [ "$first" != yes ] && [ ! -e "$tls_dir/state.json" ] && [ -e "$served" ] && [ "$(env_value PIPULSE_TLS)" != off ]; then
  # This data was served over HTTPS and its TLS material is gone and could not be remade
  # (no openssl, a full disk): stay closed. The server refuses to start rather than fall
  # back to plain HTTP behind the operator's back.
  warn "this install served HTTPS but its certificate could not be recreated (see above): PiPulse will not start until you run: sudo pipulse tls init --mode auto (or serve plain HTTP: sudo pipulse tls disable --allow-insecure)"
elif [ "$first" != yes ] && [ ! -e "$tls_dir/state.json" ]; then
  warn "HTTPS could not be prepared (see above): PiPulse stays on plain HTTP until you run: sudo pipulse tls init"
  install -d -o root -g pipulse -m 2750 "$tls_dir" 2>/dev/null || true
  if printf '{"version":1,"mode":"legacy-http"}\n' > "$tls_dir/state.json" 2>/dev/null; then
    chown root:pipulse "$tls_dir/state.json" 2>/dev/null || true
    chmod 640 "$tls_dir/state.json" 2>/dev/null || true
  else
    warn "could not write $tls_dir/state.json: the service may refuse to start; set PIPULSE_TLS=off in /etc/pipulse/pipulse.env"
  fi
fi
port=$(env_value PIPULSE_PORT)
port=${port:-8889}

# 4. Service
if [ "$start" = yes ] && [ -d /run/systemd/system ]; then
  if [ "$unit_dir" != none ]; then
    # A masked unit (a symlink to /dev/null) is the operator's: install would replace
    # it or fail under set -e, so leave it and say so.
    for unit in pipulse.service pipulse-tls-renew.service pipulse-tls-renew.timer; do
      if unit_masked "$unit"; then
        warn "$unit is masked: its unit file was left as it is"
      else
        install -m 644 "$here/$unit" "$unit_dir/$unit"
      fi
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
      health=0
      pipulse_health || health=$?
      if [ "$health" -ne 1 ]; then
        # 2: running, but its certificate failed the client check (install.sh keeps such an
        # install too: rolling back can't fix a certificate). Warn, then finish as usual.
        if [ "$health" -eq 2 ]; then
          warn "PiPulse is running, but its HTTPS certificate failed verification${HEALTH_MSG:+ ($HEALTH_MSG)}; see Settings → Certificate and journalctl -u pipulse"
        fi
        marker=$(served_marker)
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
  # Hourly check; renews only a generated certificate that is due. Enabled once: on a
  # first install, or on the first upgrade from a release without it (no marker yet).
  # After that an operator's enabled, disabled or masked choice is left as it is.
  timer_marker=/etc/pipulse/.renew-timer-enabled
  if unit_masked pipulse-tls-renew.timer; then
    warn 'pipulse-tls-renew.timer is masked: a generated HTTPS certificate will not renew by itself'
  elif [ ! -e "$timer_marker" ]; then
    if systemctl enable --now pipulse-tls-renew.timer >/dev/null 2>&1; then
      : > "$timer_marker"
    else
      warn 'could not enable pipulse-tls-renew.timer'
    fi
  elif [ "$(systemctl is-enabled pipulse-tls-renew.timer 2>/dev/null || true)" != enabled ]; then
    warn 'pipulse-tls-renew.timer is not enabled: left as it is (a generated HTTPS certificate will not renew by itself; sudo systemctl enable --now pipulse-tls-renew.timer)'
  fi
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
