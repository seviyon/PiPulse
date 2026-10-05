#!/bin/sh
# setup.sh and the service's state: enable on first install only; afterwards
# restart only an enabled service and leave a disabled or masked one alone.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
rm -rf /etc/pipulse /var/lib/pipulse; userdel pipulse 2>/dev/null || true; groupdel pipulse 2>/dev/null || true
# A first install now waits for the service to answer: stand in for the installed health check
# (and its Node), and serve plain HTTP so no tls-installed marker is expected.
mkdir -p /etc/pipulse /opt/pipulse/node/bin /opt/pipulse/app/packages/tls/dist
ln -sf "$(command -v node)" /opt/pipulse/node/bin/node
echo 'process.exit(0);' > /opt/pipulse/app/packages/tls/dist/health-check.js
echo 'PIPULSE_TLS=off' > /etc/pipulse/pipulse.env
# Pretend systemd runs: a stand-in systemctl that logs its calls and reports $STATE.
mkdir -p /run/systemd/system
fake=$(mktemp -d)
cat > "$fake/systemctl" <<'SH'
#!/bin/sh
echo "$*" >> /tmp/systemctl.log
case $1 in
  is-enabled) echo "$STATE"; [ "$STATE" = enabled ] ;;
  enable) [ "$STATE" != masked ] ;;
  *) exit 0 ;;
esac
SH
chmod +x "$fake/systemctl"
run() { : > /tmp/systemctl.log; STATE=$1 PATH="$fake:$PATH" sh "$here/setup.sh" --unit-dir none ${2:+"$2"} > /tmp/setup.out 2>&1; }

run disabled --first-install || bad 'first install ran'
grep -qx 'enable pipulse' /tmp/systemctl.log && grep -qx 'restart pipulse' /tmp/systemctl.log && ok 'first install enables and starts' || bad 'first install enables and starts'

run enabled '' || bad 'upgrade ran'
grep -qx 'restart pipulse' /tmp/systemctl.log && ! grep -qx 'enable pipulse' /tmp/systemctl.log && ok 'upgrade restarts an enabled service' || bad 'upgrade restarts an enabled service'

run disabled '' || bad 'upgrade of a disabled service ran'
! grep -qx 'enable pipulse' /tmp/systemctl.log && ! grep -qx 'restart pipulse' /tmp/systemctl.log && grep -q 'disabled' /tmp/setup.out && ok 'leaves a disabled service alone, and says so' || bad 'leaves a disabled service alone, and says so'
grep -qx 'enable --now pipulse-tls-renew.timer' /tmp/systemctl.log && ok 'enables the renewal timer' || bad 'enables the renewal timer'

if run masked ''; then ok 'a masked service does not fail the upgrade'; else bad 'a masked service does not fail the upgrade'; fi
! grep -qx 'enable pipulse' /tmp/systemctl.log && ! grep -qx 'restart pipulse' /tmp/systemctl.log && ok 'leaves a masked service alone' || bad 'leaves a masked service alone'
! grep -qx 'enable --now pipulse-tls-renew.timer' /tmp/systemctl.log && grep -q 'pipulse-tls-renew.timer is masked' /tmp/setup.out && ok 'leaves a masked timer alone, and says so' || bad 'leaves a masked timer alone, and says so'

rm -rf /run/systemd/system /opt/pipulse
exit $fail
