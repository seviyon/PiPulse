#!/bin/sh
# compose-operator.sh IMAGE — the compose deployment with an operator's own certificate:
# no CA is made, the sidecar is healthy anyway, the server serves exactly that certificate,
# a key that doesn't match stops the server with one line naming the setting, and putting
# the right key back recovers it.
set -eu
image=$1
repo=$(cd "$(dirname "$0")/../.." && pwd)
# Names unique to this run, and never an existing volume: the cleanup removes what is named
# here, so it must not be able to reach anything a developer already has.
project=pipulse-optest-$$
cfg=$project-cfg
if docker volume inspect "$cfg" >/dev/null 2>&1; then
  echo "refusing to run: the volume $cfg already exists" >&2
  exit 1
fi
work=$(mktemp -d "$repo/.compose-test.XXXXXX") # inside the repo: Colima shares only the home folder
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
openssl=${PIPULSE_TEST_OPENSSL:-openssl}
host=pulse-op-test
mkdir -p "$work/timesync" "$work/gen" && touch "$work/timesync/synchronized"
printf '%s\n' "$host" > "$work/hostname"

# An operator's CA and a leaf for the host name, localhost and the loopback addresses.
cd "$work/gen"
"$openssl" ecparam -name prime256v1 -genkey -noout -out ca.key 2>/dev/null
"$openssl" req -x509 -new -key ca.key -sha256 -days 30 -subj '/CN=Operator Test CA' -out ca.pem \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
"$openssl" ecparam -name prime256v1 -genkey -noout -out leaf.key 2>/dev/null
"$openssl" ecparam -name prime256v1 -genkey -noout -out other.key 2>/dev/null
"$openssl" req -new -key leaf.key -subj "/CN=$host" -out leaf.csr 2>/dev/null
printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$host" > leaf.ext
"$openssl" x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -sha256 -extfile leaf.ext -out leaf.pem 2>/dev/null
rm -f leaf.csr leaf.ext ca.srl ca.key
cd "$repo"
want=$("$openssl" x509 -in "$work/gen/leaf.pem" -noout -fingerprint -sha256 | sed 's/.*=//')

{
  echo 'PIPULSE_PORT=18892'
  echo 'PIPULSE_TLS_CERT=/etc/pipulse/leaf.pem'
  echo 'PIPULSE_TLS_KEY=/etc/pipulse/leaf.key'
  echo 'PIPULSE_TLS_CA=/etc/pipulse/ca.pem'
} > "$work/pipulse.env"
# The operator's files live in a volume owned by the image's pipulse user (uid 999), the key 0600,
# as an operator on a Linux host would make them with chown and chmod.
put() { # put KEYFILE → /etc/pipulse/leaf.key in the volume
  docker run --rm -u 0 -v "$cfg:/c" -v "$work/gen:/gen:ro" --entrypoint sh "$image" -c \
    "cp /gen/ca.pem /gen/leaf.pem /c/ && cp /gen/$1 /c/leaf.key && chown 999:999 /c/* && chmod 600 /c/leaf.key && chmod 644 /c/*.pem"
}
docker volume create "$cfg" >/dev/null
put leaf.key
sed -e "s#ghcr.io/seviyon/pipulse:[^ ]*#$image#" -e "s#- ./config:/etc/pipulse:ro#- $cfg:/etc/pipulse:ro#" -e "s#/run/systemd/timesync#$work/timesync#" -e "s#- /etc/hostname:#- $work/hostname:#" \
  -e '/\/boot\/firmware/d' -e '/os-release/d' -e '/device-tree/d' "$repo/compose.yaml" > "$work/compose.yaml"
printf '  %s:\n    external: true\n' "$cfg" >> "$work/compose.yaml"
dc() { docker compose -p "$project" -f "$work/compose.yaml" "$@"; }
trap 'dc down -v >/dev/null 2>&1 || true; docker volume rm "$cfg" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q "$1")" 2>/dev/null)" = healthy ]; }
api() { dc exec -T -e NODE_EXTRA_CA_CERTS=/etc/pipulse/ca.pem pipulse node -e "fetch('https://localhost:18892$1').then(r=>r.text()).then(t=>process.stdout.write(t))"; }

dc up -d >/dev/null 2>&1
for _ in $(seq 1 120); do healthy pipulse && break; sleep 1; done
healthy pipulse && ok 'compose up: the server is healthy with an operator certificate' || { dc logs; bad 'compose up: the server is healthy with an operator certificate'; }
healthy pipulse-tls && ok 'the sidecar is healthy without making a CA' || bad 'the sidecar is healthy without making a CA'
dc exec -T pipulse-tls test ! -e /tls-ca/ca && dc exec -T pipulse-tls test ! -e /tls/ca.crt && ok 'no CA or generated certificate exists' || bad 'no CA or generated certificate exists'
api /api/health | grep -q '"source":"operator"' && ok '/api/health says the certificate is the operator one' || bad '/api/health says the certificate is the operator one'
served=$(dc exec -T pipulse node -e "
const t=require('node:tls');const s=t.connect({host:'127.0.0.1',port:18892,servername:'localhost',ca:require('node:fs').readFileSync('/etc/pipulse/ca.pem')},()=>{process.stdout.write(s.getPeerCertificate().fingerprint256);s.end()})")
[ "$served" = "$want" ] && ok 'the server serves exactly the operator certificate' || bad "the server serves exactly the operator certificate ($served != $want)"
dc exec -T pipulse node /opt/pipulse/app/packages/tls/dist/health-check.js >/dev/null && ok 'the shared health check verifies it against PIPULSE_TLS_CA' || bad 'the shared health check verifies it against PIPULSE_TLS_CA'

# A key that does not match the certificate: one line naming the setting, no HTTP fallback.
put other.key
dc up -d --force-recreate pipulse >/dev/null 2>&1 || true
sleep 15
logs=$(dc logs pipulse 2>&1 || true)
echo "$logs" | grep -q 'PIPULSE_TLS_CERT/PIPULSE_TLS_KEY' && ok 'a mismatched key stops the server with a line naming the setting' || bad 'a mismatched key stops the server with a line naming the setting'
healthy pipulse && bad 'a mismatched key must not leave a healthy server' || ok 'and the server is not healthy'
if dc exec -T pipulse-tls pipulse tls sidecar-health >/dev/null 2>&1; then ok 'the sidecar stays healthy'; else bad 'the sidecar stays healthy'; fi

# The right key again: the restart policy brings it back.
put leaf.key
dc up -d --force-recreate pipulse >/dev/null 2>&1
for _ in $(seq 1 120); do healthy pipulse && break; sleep 1; done
healthy pipulse && ok 'the right key recovers the server' || { dc logs pipulse; bad 'the right key recovers the server'; }
exit $fail
