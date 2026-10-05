#!/bin/sh
# Mode selection on install and upgrade (spec "Setup and migration"): fresh → https, upgrade →
# legacy-http with HTTPS prepared, state.json never touched, lost folder + marker → https, and
# a fresh install stays fresh until setup has made HTTPS work.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
"$repo/packaging/build-tarball.sh" 0.0.2 "$out" >/dev/null
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
state() { sed -n 's/.*"mode":"\([^"]*\)".*/\1/p' /etc/pipulse/tls/state.json 2>/dev/null; }
fp() { openssl x509 -in /etc/pipulse/tls/ca.crt -noout -fingerprint -sha256 2>/dev/null; }
# No timesyncd here: an unknown clock is accepted for making a CA (with a warning).

# 1. Fresh install.
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start > /tmp/i.log 2>&1 || { cat /tmp/i.log; bad 'fresh install ran'; }
[ "$(state)" = https ] && ok 'fresh install selects https' || bad "fresh install selects https (got $(state))"
grep -q 'CA SHA-256 fingerprint:' /tmp/i.log && ok 'fresh install prints the CA fingerprint' || bad 'fresh install prints the CA fingerprint'
grep -q 'IP access .* is not covered' /tmp/i.log && ok 'and says IP access is not covered' || bad 'and says IP access is not covered'
first=$(fp)

# 2. Upgrade with state.json: untouched, same CA.
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.2.tar.gz" --no-start >/dev/null 2>&1
[ "$(state)" = https ] && [ "$(fp)" = "$first" ] && ok 'upgrade keeps state.json and the CA' || bad 'upgrade keeps state.json and the CA'

# 3. Upgrade from a pre-6b install (no /etc/pipulse/tls, data present).
rm -rf /etc/pipulse/tls /var/lib/pipulse/tls-installed
echo data > /var/lib/pipulse/pipulse.sqlite
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start > /tmp/u.log 2>&1
[ "$(state)" = legacy-http ] && ok 'pre-6b upgrade stays on HTTP' || bad "pre-6b upgrade stays on HTTP (got $(state))"
[ -e /etc/pipulse/tls/leaf.pem ] && ok 'and HTTPS is prepared' || bad 'and HTTPS is prepared'
grep -q 'sudo pipulse tls enable' /tmp/u.log && ok 'and says how to enable it' || bad 'and says how to enable it'

# 4. Reinstall over kept data after --uninstall of a pre-6b version: still HTTP.
sh "$repo/packaging/install.sh" --uninstall >/dev/null
rm -rf /etc/pipulse/tls
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start >/dev/null 2>&1
[ "$(state)" = legacy-http ] && ok 'a reinstall over old data stays on HTTP' || bad "a reinstall over old data stays on HTTP (got $(state))"

# 5. The TLS folder is lost on data that was served over HTTPS: back to https, new CA, warned.
rm -rf /etc/pipulse/tls
touch /var/lib/pipulse/tls-installed
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.2.tar.gz" --no-start > /tmp/l.log 2>&1
[ "$(state)" = https ] && grep -q 'every device must trust the new CA' /tmp/l.log && ok 'a lost TLS folder on HTTPS data goes back to https, with a warning' || bad 'lost TLS folder'

# 6. The installer's subnet answer reaches init on a fresh install.
sh "$repo/packaging/install.sh" --purge >/dev/null
PIPULSE_TLS_INIT_SUBNET=192.168.77.0/24 sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start >/dev/null 2>&1
grep -q '192.168.77.0/24' /etc/pipulse/tls/ca-meta.json && ok 'an accepted subnet is in the CA' || bad 'an accepted subnet is in the CA'
[ ! -e /etc/pipulse/.first-install-pending ] && ok 'a successful fresh install leaves no pending marker' || bad 'a successful fresh install leaves no pending marker'

# 7. A fresh install whose HTTPS setup fails is retried as a fresh install, and settings that
#    exist only in pipulse.env (not the environment) reach setup's init.
sh "$repo/packaging/install.sh" --purge >/dev/null
install -d -m 750 /etc/pipulse
printf 'PIPULSE_TLS_DIR=/srv/pipulse-tls\nPIPULSE_TLS_SUBNETS=192.168.77.0/24\n' > /etc/pipulse/pipulse.env
if sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start > /tmp/f.log 2>&1; then bad 'a refused TLS folder fails the fresh install'; else ok 'a refused TLS folder fails the fresh install'; fi
grep -q 'PIPULSE_TLS_DIR=/srv/pipulse-tls' /tmp/f.log && [ ! -e /srv/pipulse-tls ] && ok 'setup refuses a PIPULSE_TLS_DIR set only in pipulse.env' || bad 'setup refuses a PIPULSE_TLS_DIR set only in pipulse.env'
[ -e /etc/pipulse/.first-install-pending ] && ok 'the failed fresh install stays pending' || bad 'the failed fresh install stays pending'
sed -i '/PIPULSE_TLS_DIR/d' /etc/pipulse/pipulse.env
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start > /tmp/r.log 2>&1 || { cat /tmp/r.log; bad 'the retry ran'; }
[ "$(state)" = https ] && ok 'the retry is still a fresh install (https)' || bad "the retry is still a fresh install (got $(state))"
grep -q '192.168.77.0/24' /etc/pipulse/tls/ca-meta.json && ok 'PIPULSE_TLS_SUBNETS from pipulse.env alone is honoured' || bad 'PIPULSE_TLS_SUBNETS from pipulse.env alone is honoured'
[ ! -e /etc/pipulse/.first-install-pending ] && ok 'the pending marker goes once it worked' || bad 'the pending marker goes once it worked'

# 8. A first run that died after deploying the app, before setup ran: the retry is fresh too.
sh "$repo/packaging/install.sh" --purge >/dev/null
mkdir -p /opt/pipulse/app /opt/pipulse/node && echo '{"version":"0.0.0"}' > /opt/pipulse/app/version.json
install -d -m 750 /etc/pipulse && : > /etc/pipulse/.first-install-pending
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start > /tmp/d.log 2>&1 || { cat /tmp/d.log; bad 'the retry after an early death ran'; }
[ "$(state)" = https ] && ok 'a retry after dying before setup is a fresh install' || bad "a retry after dying before setup is a fresh install (got $(state))"

# 9. The installer's own post-install probe (the shared check under env -i): over verified TLS
#    after a fresh HTTPS install, over HTTP with PIPULSE_TLS=off. The stand-in restart starts
#    the real server the way the unit would.
sh "$repo/packaging/install.sh" --purge >/dev/null
cat > /usr/local/bin/pipulse-test-restart <<'SH'
#!/bin/sh
pkill -f /opt/pipulse/app/packages/api/dist/server.js || true
sleep 1
setpriv --reuid=pipulse --regid=pipulse --init-groups sh -c 'set -a; . /etc/pipulse/pipulse.env; set +a; cd /var/lib/pipulse; PIPULSE_DB_PATH=/var/lib/pipulse/pipulse.sqlite exec /opt/pipulse/node/bin/node --disable-warning=ExperimentalWarning /opt/pipulse/app/packages/api/dist/server.js' >> /tmp/probe-server.log 2>&1 &
SH
chmod +x /usr/local/bin/pipulse-test-restart
: > /tmp/probe-server.log
probe() { PIPULSE_FORCE_RESTART=1 PIPULSE_RESTART_CMD=/usr/local/bin/pipulse-test-restart PIPULSE_STOP_CMD='pkill -f /opt/pipulse/app/packages/api/dist/server.js' PIPULSE_HEALTH_WAIT=40 sh "$repo/packaging/install.sh" --from "$1" > /tmp/probe.log 2>&1; }
probe "$out/pipulse-0.0.1.tar.gz" || cat /tmp/probe.log
grep -q 'running 0.0.1' /tmp/probe.log && grep -q 'listening on https://' /tmp/probe-server.log && ok 'the post-install probe passes over verified TLS' || bad 'the post-install probe passes over verified TLS'
[ -e /var/lib/pipulse/tls-installed ] && ok 'the server marked its data as served over HTTPS' || bad 'the server marked its data as served over HTTPS'
echo 'PIPULSE_TLS=off' >> /etc/pipulse/pipulse.env
probe "$out/pipulse-0.0.2.tar.gz" || cat /tmp/probe.log
grep -q 'running 0.0.2' /tmp/probe.log && grep -q 'listening on http://' /tmp/probe-server.log && ok 'with PIPULSE_TLS=off the probe goes over HTTP' || bad 'with PIPULSE_TLS=off the probe goes over HTTP'
pkill -f /opt/pipulse/app/packages/api/dist/server.js || true
rm -f /usr/local/bin/pipulse-test-restart
sh "$repo/packaging/install.sh" --purge >/dev/null
# 10. init dying before it writes state.json (a full disk, a wrong owner): an upgrade falls back to
#     plain HTTP instead of restarting into "no mode chosen"; a first install fails loudly.
sh "$repo/packaging/install.sh" --purge >/dev/null
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" --no-start >/dev/null 2>&1
rm -rf /etc/pipulse/tls
stub=$(mktemp -d)
mkdir -p "$stub/packaging" "$stub/packages/tls/dist"
cp "$repo/packaging/setup.sh" "$repo/packaging/lib.sh" "$repo/packaging/pipulse.env" "$stub/packaging/"
echo 'process.exit(1);' > "$stub/packages/tls/dist/cli.js"
sh "$stub/packaging/setup.sh" --no-start > /tmp/x.log 2>&1 || { cat /tmp/x.log; bad 'an upgrade whose init died still completes'; }
[ "$(state)" = legacy-http ] && ok 'an upgrade whose init died falls back to plain HTTP' || bad "an upgrade whose init died falls back to plain HTTP (got $(state))"
grep -q 'stays on plain HTTP' /tmp/x.log && ok 'and says so' || bad 'and says so'
rm -rf /etc/pipulse/tls
if sh "$stub/packaging/setup.sh" --no-start --first-install > /tmp/y.log 2>&1; then bad 'a first install whose init died fails'; else ok 'a first install whose init died fails'; fi
[ -z "$(state)" ] && ok 'and writes no state' || bad 'and writes no state'
sh "$repo/packaging/install.sh" --purge >/dev/null
exit $fail
