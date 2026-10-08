#!/bin/sh
# setup.sh and the service's state: enable on first install only; afterwards
# restart only an enabled service and leave a disabled or masked one alone. The renewal
# timer is enabled once, then its state is the operator's.
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
run() { : > /tmp/systemctl.log; STATE=$1 PATH="$fake:$PATH" sh "$here/setup.sh" --unit-dir "${UNIT_DIR:-none}" ${2:+"$2"} > /tmp/setup.out 2>&1; }
timer_on() { grep -qx 'enable --now pipulse-tls-renew.timer' /tmp/systemctl.log; }

run disabled --first-install || bad 'first install ran'
grep -qx 'enable pipulse' /tmp/systemctl.log && grep -qx 'restart pipulse' /tmp/systemctl.log && ok 'first install enables and starts' || bad 'first install enables and starts'
timer_on && [ -e /etc/pipulse/.renew-timer-enabled ] && ok 'first install enables the renewal timer once' || bad 'first install enables the renewal timer once'

# Running but its certificate fails the client check (exit 2): warn and finish, like install.sh.
printf '%s\n' 'process.stderr.write("[pipulse] health check: unable to get local issuer certificate\n"); process.exit(2);' > /opt/pipulse/app/packages/tls/dist/health-check.js
touch /etc/pipulse/.first-install-pending
if run disabled --first-install; then ok 'a certificate that fails verification does not abort a first install'; else bad 'a certificate that fails verification does not abort a first install'; fi
grep -q 'failed verification (unable to get local issuer certificate)' /tmp/setup.out && [ ! -e /etc/pipulse/.first-install-pending ] && ok 'it warns with the reason and clears the pending marker' || bad 'it warns with the reason and clears the pending marker'
echo 'process.exit(1);' > /opt/pipulse/app/packages/tls/dist/health-check.js
touch /etc/pipulse/.first-install-pending
if PIPULSE_HEALTH_WAIT=1 run disabled --first-install; then bad 'an unhealthy first install fails'; else ok 'an unhealthy first install fails'; fi
[ -e /etc/pipulse/.first-install-pending ] && ok 'and stays pending' || bad 'and stays pending'
rm -f /etc/pipulse/.first-install-pending
echo 'process.exit(0);' > /opt/pipulse/app/packages/tls/dist/health-check.js

run enabled '' || bad 'upgrade ran'
grep -qx 'restart pipulse' /tmp/systemctl.log && ! grep -qx 'enable pipulse' /tmp/systemctl.log && ok 'upgrade restarts an enabled service' || bad 'upgrade restarts an enabled service'

run disabled '' || bad 'upgrade of a disabled service ran'
! grep -qx 'enable pipulse' /tmp/systemctl.log && ! grep -qx 'restart pipulse' /tmp/systemctl.log && grep -q 'disabled' /tmp/setup.out && ok 'leaves a disabled service alone, and says so' || bad 'leaves a disabled service alone, and says so'
! timer_on && grep -q 'pipulse-tls-renew.timer is not enabled: left as it is' /tmp/setup.out && ok 'an upgrade leaves a disabled timer disabled, and says so' || bad 'an upgrade leaves a disabled timer disabled, and says so'

if run masked ''; then ok 'a masked service does not fail the upgrade'; else bad 'a masked service does not fail the upgrade'; fi
! grep -qx 'enable pipulse' /tmp/systemctl.log && ! grep -qx 'restart pipulse' /tmp/systemctl.log && ok 'leaves a masked service alone' || bad 'leaves a masked service alone'
! timer_on && grep -q 'pipulse-tls-renew.timer is masked' /tmp/setup.out && ok 'leaves a masked timer alone, and says so' || bad 'leaves a masked timer alone, and says so'

# An upgrade from a release without the timer (no marker) enables it once.
rm -f /etc/pipulse/.renew-timer-enabled
run disabled '' || bad 'upgrade from a release without the timer ran'
timer_on && [ -e /etc/pipulse/.renew-timer-enabled ] && ok 'the first upgrade that has the timer enables it once' || bad 'the first upgrade that has the timer enables it once'
run disabled '' || bad 'second upgrade ran'
! timer_on && ok 'the next upgrade keeps it disabled' || bad 'the next upgrade keeps it disabled'

# A real mask (a link to /dev/null in the unit folder) must not abort setup or be replaced.
units=$(mktemp -d)
ln -s /dev/null "$units/pipulse-tls-renew.timer"
rm -f /etc/pipulse/.renew-timer-enabled
if UNIT_DIR=$units run disabled ''; then ok 'a masked timer file does not fail the upgrade'; else bad 'a masked timer file does not fail the upgrade'; fi
[ "$(readlink "$units/pipulse-tls-renew.timer")" = /dev/null ] && [ -f "$units/pipulse-tls-renew.service" ] && ok 'the mask is left in place and the other units are installed' || bad 'the mask is left in place and the other units are installed'

rm -rf /run/systemd/system /opt/pipulse
exit $fail
