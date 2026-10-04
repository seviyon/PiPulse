#!/bin/sh
# The generated-certificate CLI on a real tarball install, as root in a Debian
# container: modes and owners, idempotent init, the service user's access,
# enable/disable through a stand-in systemctl, a CA change killed half-way,
# restore, the renew unit's files, and no network sockets while issuing.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
m() { stat -c '%U:%G %a' "$1"; }
as_pipulse() { setpriv --reuid=pipulse --regid=pipulse --init-groups "$@"; }
tls=/etc/pipulse/tls

sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start >/dev/null
[ ! -e "$tls" ] && ok 'installing makes no CA and no state.json' || bad 'installing makes no CA and no state.json'
# No timesyncd in a container: trust the clock, as a chrony host would.
printf 'PIPULSE_TLS_CLOCK=trust\nPIPULSE_PORT=18889\n' >> /etc/pipulse/pipulse.env

pipulse tls init > /tmp/init.log 2>&1 && ok 'init' || { cat /tmp/init.log; bad 'init'; }
fp=$(sed -n 's/^CA SHA-256 fingerprint: //p' /tmp/init.log)
[ -n "$fp" ] && ok 'init prints the CA fingerprint' || bad 'init prints the CA fingerprint'
[ "$(m $tls)" = 'root:pipulse 2750' ] && ok 'tls folder root:pipulse 2750' || bad "tls folder ($(m $tls))"
[ "$(m $tls/ca)" = 'root:root 700' ] && ok 'ca folder root:root 700' || bad "ca folder ($(m $tls/ca))"
[ "$(m $tls/ca/ca.key)" = 'root:root 600' ] && ok 'ca.key root:root 600' || bad "ca.key ($(m $tls/ca/ca.key))"
[ "$(m $tls/leaf.pem)" = 'root:pipulse 640' ] && ok 'leaf.pem root:pipulse 640' || bad "leaf.pem ($(m $tls/leaf.pem))"
[ "$(m $tls/ca.crt)" = 'root:pipulse 644' ] && ok 'ca.crt root:pipulse 644' || bad "ca.crt ($(m $tls/ca.crt))"
as_pipulse cat $tls/leaf.pem >/dev/null && ok 'the service reads leaf.pem' || bad 'the service reads leaf.pem'
if as_pipulse cat $tls/ca/ca.key >/dev/null 2>&1; then bad 'the service cannot read ca.key'; else ok 'the service cannot read ca.key'; fi
if as_pipulse touch $tls/intruder 2>/dev/null; then bad 'the service cannot write the tls folder'; else ok 'the service cannot write the tls folder'; fi
openssl verify -CAfile $tls/ca/ca.crt $tls/leaf.crt >/dev/null && ok 'the leaf verifies with openssl' || bad 'the leaf verifies with openssl'
pipulse tls init >/dev/null 2>&1
pipulse tls status | grep -q "SHA-256 $fp" && ok 'a second init keeps the CA' || bad 'a second init keeps the CA'
as_pipulse /opt/pipulse/node/bin/node /opt/pipulse/app/packages/tls/dist/cli.js status | grep -q "SHA-256 $fp" && ok 'status works as the service user' || bad 'status works as the service user'
pipulse tls status 2>/tmp/epipe.err | head -n 1 >/dev/null
! grep -q 'EPIPE\|Unhandled' /tmp/epipe.err && ok 'a closed pipe is not an error' || bad 'a closed pipe is not an error'
# ...and it must not cut a command short either: init | head -n 1 still makes the CA, and init says it worked.
rm -rf "$tls"
( pipulse tls init 2>&1; echo $? > /tmp/init.rc ) | head -n 1 >/dev/null
[ "$(cat /tmp/init.rc)" = 0 ] && [ -e "$tls/ca/ca.key" ] && openssl verify -CAfile "$tls/ca/ca.crt" "$tls/leaf.crt" >/dev/null 2>&1 && ok 'init piped to head still makes the CA' || bad 'init piped to head still makes the CA'
pipulse tls export-ca 2>/dev/null | cmp -s - $tls/ca.crt && ok 'export-ca prints ca.crt' || bad 'export-ca prints ca.crt'
# A native install keeps generated material only in /etc/pipulse/tls (the renew unit can't write elsewhere).
if PIPULSE_TLS_DIR=/srv/pipulse-tls pipulse tls init > /tmp/dir.log 2>&1; then
  bad 'a non-default PIPULSE_TLS_DIR is refused natively'
else
  grep -q 'PIPULSE_TLS_DIR=/srv/pipulse-tls' /tmp/dir.log && [ ! -e /srv/pipulse-tls ] && ok 'a non-default PIPULSE_TLS_DIR is refused natively' || bad 'a non-default PIPULSE_TLS_DIR is refused natively'
fi

# enable/disable through a stand-in systemctl that (re)starts the real server.
# The CLI calls systemctl with PATH=/usr/sbin:/usr/bin:/sbin:/bin, so it sits in /usr/sbin.
cat > /usr/sbin/systemctl <<'SH'
#!/bin/sh
echo "$*" >> /tmp/systemctl.log
[ "$1 $2" = 'restart pipulse' ] || exit 0
pkill -f /opt/pipulse/app/packages/api/dist/server.js || true
sleep 1
if [ -e /tmp/fake-broken ] && grep -q '"https"' /etc/pipulse/tls/state.json 2>/dev/null; then exit 0; fi
setpriv --reuid=pipulse --regid=pipulse --init-groups sh -c 'set -a; . /etc/pipulse/pipulse.env; set +a; cd /var/lib/pipulse; PIPULSE_DB_PATH=/var/lib/pipulse/pipulse.sqlite exec /opt/pipulse/node/bin/node --disable-warning=ExperimentalWarning /opt/pipulse/app/packages/api/dist/server.js' >> /tmp/server.log 2>&1 &
SH
chmod +x /usr/sbin/systemctl
pipulse tls enable --yes > /tmp/enable.log 2>&1 && ok 'enable' || { cat /tmp/enable.log /tmp/server.log; bad 'enable'; }
curl -fs --cacert $tls/ca.crt https://localhost:18889/api/health | grep -q '"monitoring":"ok"' && ok 'serves HTTPS with the generated certificate' || bad 'serves HTTPS with the generated certificate'
pipulse tls disable --yes >/dev/null 2>&1 && ok 'disable' || bad 'disable'
curl -fs http://127.0.0.1:18889/api/health | grep -q '"monitoring":"ok"' && ok 'back on HTTP' || bad 'back on HTTP'
touch /tmp/fake-broken
if pipulse tls enable --yes > /tmp/enable.log 2>&1; then bad 'a failed enable fails'; else ok 'a failed enable fails'; fi
grep -q '"legacy-http"' $tls/state.json && ok 'a failed enable puts legacy-http back' || bad 'a failed enable puts legacy-http back'
curl -fs http://127.0.0.1:18889/api/health | grep -q '"monitoring":"ok"' && ok 'and HTTP answers again' || bad 'and HTTP answers again'
rm -f /tmp/fake-broken
pkill -f /opt/pipulse/app/packages/api/dist/server.js || true
rm -f /usr/sbin/systemctl

# A CA change killed at different moments always recovers to one consistent CA and leaf.
for delay in 0.05 0.15 0.3 0.5 0.8; do
  rm -rf "$tls"
  pipulse tls init >/dev/null 2>&1
  pipulse tls new-ca --subnet 10.10.0.0/24 --yes >/dev/null 2>&1 &
  pid=$!
  sleep "$delay"
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pipulse tls renew >/dev/null 2>&1 || true # any command but status finishes or rolls back
  # The killed command's lock is stale now (its pid is gone): the next command clears it.
  leftovers=''
  for f in "$tls"/.next-* "$tls"/ca.next-* "$tls"/txn.json "$tls"/.pipulse-tls.lock "$tls"/.*.tmp; do
    [ -e "$f" ] && leftovers="$leftovers $(basename "$f")"
  done
  if [ -z "$leftovers" ] && cmp -s "$tls/ca/ca.crt" "$tls/ca.crt" && openssl verify -CAfile "$tls/ca/ca.crt" "$tls/leaf.crt" >/dev/null 2>&1; then
    ok "killed after ${delay}s: one consistent CA and leaf"
  else
    bad "killed after ${delay}s: one consistent CA and leaf (leftovers: $leftovers)"
  fi
done

# restore-ca brings the first CA back.
rm -rf "$tls"
pipulse tls init >/dev/null 2>&1
first=$(openssl x509 -in $tls/ca.crt -noout -fingerprint -sha256)
sleep 1
pipulse tls new-ca --yes >/dev/null 2>&1
set -- "$tls"/ca.old-*
backup=$(basename "$1")
pipulse tls restore-ca "$backup" --yes >/dev/null 2>&1
[ "$(openssl x509 -in $tls/ca.crt -noout -fingerprint -sha256)" = "$first" ] && ok 'restore-ca brings the first CA back' || bad 'restore-ca brings the first CA back'

# Issuing opens no network socket (the renew unit's IPAddressDeny must never matter).
if command -v strace >/dev/null 2>&1 && strace -f -qq -e trace=socket -o /tmp/strace.log true 2>/dev/null; then
  strace -f -qq -e trace=socket,connect -o /tmp/strace.log pipulse tls renew --force >/dev/null 2>&1
  if grep -qE 'AF_INET6?' /tmp/strace.log; then bad "renew opens no IP socket ($(grep -E 'AF_INET6?' /tmp/strace.log | head -n 1))"; else ok 'renew opens no IP socket'; fi
else
  echo '# strace unavailable: socket test skipped'
fi

# The renewal units are valid systemd units.
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify /opt/pipulse/app/packaging/pipulse-tls-renew.service /opt/pipulse/app/packaging/pipulse-tls-renew.timer >/tmp/verify.log 2>&1 && ok 'renewal units verify' || { cat /tmp/verify.log; bad 'renewal units verify'; }
fi

# Removal keeps the TLS folder; purge removes it.
sh "$repo/packaging/install.sh" --uninstall >/dev/null
[ -e $tls/ca/ca.key ] && ok 'uninstall keeps /etc/pipulse/tls' || bad 'uninstall keeps /etc/pipulse/tls'
sh "$repo/packaging/install.sh" --purge >/dev/null
[ ! -e /etc/pipulse ] && ok 'purge removes it' || bad 'purge removes it'
exit $fail
