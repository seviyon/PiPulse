#!/bin/sh
# compose.sh IMAGE — the compose deployment: healthy, owners and modes, the server can't
# see the CA or write /tls, the marker, a stable CA, capabilities, a failing or stopped
# sidecar never stops the server, the clock gate, and an existing volume staying on HTTP.
set -eu
image=$1
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "$repo/.compose-test.XXXXXX") # inside the repo: Colima shares only the home folder
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
mkdir -p "$work/timesync" "$work/config" && touch "$work/timesync/synchronized"
printf 'PIPULSE_PORT=18891\n' > "$work/pipulse.env"
# The test compose file: the test image, a fake clock signal, no Pi-only host files.
sed -e "s#ghcr.io/seviyon/pipulse:[^ ]*#$image#" -e "s#/run/systemd/timesync#$work/timesync#" \
  -e '/\/boot\/firmware/d' -e '/os-release/d' -e '/device-tree/d' "$repo/compose.yaml" > "$work/compose.yaml"
dc() { docker compose -p pipulse-test -f "$work/compose.yaml" "$@"; }
trap 'dc down -v >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

dc up -d >/dev/null 2>&1
healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q "$1")" 2>/dev/null)" = healthy ]; }
for _ in $(seq 1 120); do healthy pipulse && break; sleep 1; done
healthy pipulse && ok 'compose up: the server is healthy' || { dc logs; bad 'compose up: the server is healthy'; }
healthy pipulse-tls && ok 'the sidecar is healthy' || bad 'the sidecar is healthy'
[ "$(dc exec -T pipulse-tls stat -c '%U:%G %a' /tls /tls-ca /tls-ca/ca/ca.key /tls/leaf.pem | tr '\n' ' ')" = 'root:pipulse 2750 root:root 700 root:root 600 root:pipulse 640 ' ] && ok 'volume owners and modes' || bad "volume owners and modes ($(dc exec -T pipulse-tls stat -c '%n %U:%G %a' /tls /tls-ca /tls-ca/ca/ca.key /tls/leaf.pem | tr '\n' ' '))"
dc exec -T pipulse test ! -e /tls-ca && ok 'the server has no CA volume' || bad 'the server has no CA volume'
if dc exec -T pipulse touch /tls/intruder 2>/dev/null; then bad 'the server cannot write /tls'; else ok 'the server cannot write /tls'; fi
dc exec -T pipulse cat /tls/leaf.pem >/dev/null && ok 'the server reads leaf.pem' || bad 'the server reads leaf.pem'
dc exec -T pipulse test -e /data/tls-installed && ok 'the server marked the data as served over HTTPS' || bad 'tls-installed marker'
dc exec -T pipulse node /opt/pipulse/app/packages/tls/dist/health-check.js && ok 'verified HTTPS from inside' || bad 'verified HTTPS from inside'
dc exec -T pipulse pipulse tls status | grep -q 'HTTPS, pid' && ok 'status sees the running server' || bad 'status sees the running server'
[ "$(dc exec -T pipulse-tls grep CapEff /proc/1/status | awk '{print $2}')" = 0000000000000000 ] && ok 'the sidecar has no capabilities' || bad 'the sidecar has no capabilities'
[ "$(docker inspect -f '{{.HostConfig.CapAdd}}' "$(dc ps -aq pipulse-tls-init)" | sed 's/CAP_//')" = '[CHOWN]' ] && ok 'the init service has only CHOWN' || bad 'the init service has only CHOWN'
fp1=$(dc logs pipulse-tls | sed -n 's/.*CA SHA-256 fingerprint: //p' | head -n 1)
dc restart pipulse-tls >/dev/null 2>&1
for _ in $(seq 1 60); do healthy pipulse-tls && break; sleep 1; done
[ "$(dc logs pipulse-tls | sed -n 's/.*CA SHA-256 fingerprint: //p' | sort -u | wc -l | tr -d ' ')" = 1 ] && [ -n "$fp1" ] && ok 'a restart keeps and reprints the same CA' || bad 'a restart keeps and reprints the same CA'

# A failing renewal (unreadable CA key: root has no DAC override there) is a certificate problem:
# the sidecar stays healthy (so `compose up` still starts the server) and the server keeps serving.
dc exec -T pipulse-tls chmod 000 /tls-ca/ca/ca.key
dc exec -T pipulse-tls pipulse tls renew --force >/dev/null 2>&1 || true
if dc exec -T pipulse-tls pipulse tls sidecar-health >/dev/null 2>&1; then ok 'a failing renewal does not make the sidecar unhealthy'; else bad 'a failing renewal does not make the sidecar unhealthy'; fi
restarts=$(docker inspect -f '{{.RestartCount}}' "$(dc ps -q pipulse)")
dc exec -T pipulse node /opt/pipulse/app/packages/tls/dist/health-check.js && ok 'the server keeps serving' || bad 'the server keeps serving'
dc exec -T pipulse-tls chmod 600 /tls-ca/ca/ca.key
dc stop pipulse-tls >/dev/null 2>&1
dc exec -T pipulse node /opt/pipulse/app/packages/tls/dist/health-check.js && ok 'a stopped sidecar leaves the server serving' || bad 'a stopped sidecar leaves the server serving'
[ "$(docker inspect -f '{{.RestartCount}}' "$(dc ps -q pipulse)")" = "$restarts" ] && ok 'and compose never restarted it' || bad 'and compose never restarted it'
dc start pipulse-tls >/dev/null 2>&1
for _ in $(seq 1 60); do healthy pipulse-tls && break; sleep 1; done

# No clock signal: renewal waits; PIPULSE_TLS_CLOCK=trust lets it renew.
rm "$work/timesync/synchronized"
dc exec -T pipulse-tls pipulse tls renew --force | grep -q 'waiting for clock synchronization' && ok 'an unsynced clock makes renewal wait' || bad 'an unsynced clock makes renewal wait'
rmdir "$work/timesync" 2>/dev/null || true
dc exec -T -e PIPULSE_TLS_TIMESYNC_DIR=/nonexistent -e PIPULSE_TLS_CLOCK=trust pipulse-tls pipulse tls renew --force | grep -q '^renewed' && ok 'PIPULSE_TLS_CLOCK=trust renews with no signal' || bad 'PIPULSE_TLS_CLOCK=trust renews with no signal'
dc down -v >/dev/null 2>&1
mkdir -p "$work/timesync" && touch "$work/timesync/synchronized"

# An existing data volume (an HTTP install) stays on HTTP, with HTTPS prepared.
docker volume create pipulse-test_pipulse-data >/dev/null
docker run --rm -u 0 -v pipulse-test_pipulse-data:/data --entrypoint sh "$image" -c 'touch /data/pipulse.sqlite && chown -R 999:999 /data'
dc up -d >/dev/null 2>&1
for _ in $(seq 1 120); do healthy pipulse && break; sleep 1; done
dc exec -T pipulse-tls cat /tls/state.json | grep -q legacy-http && ok 'existing data stays on HTTP' || bad 'existing data stays on HTTP'
dc logs pipulse | grep -q 'HTTPS is ready: docker compose run --rm pipulse-tls pipulse tls enable --yes' && ok 'the server says how to enable HTTPS' || bad 'the server says how to enable HTTPS'
exit $fail
