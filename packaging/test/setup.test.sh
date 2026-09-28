#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
groupadd -f video
# Start clean (a previous test in the same container may have installed PiPulse).
rm -rf /etc/pipulse /var/lib/pipulse; userdel pipulse 2>/dev/null || true; groupdel pipulse 2>/dev/null || true
sh "$here/setup.sh" --no-start > /tmp/setup.log 2>&1 || { cat /tmp/setup.log; bad 'setup ran'; }
id pipulse >/dev/null 2>&1 && ok 'user exists' || bad 'user exists'
[ "$(getent passwd pipulse | cut -d: -f7)" = /usr/sbin/nologin ] && ok 'no login shell' || bad 'no login shell'
id -nG pipulse | grep -qw video && ok 'in video group' || bad 'in video group'
[ "$(stat -c '%U:%G %a' /etc/pipulse)" = 'root:pipulse 750' ] && ok '/etc/pipulse mode' || bad '/etc/pipulse mode'
[ "$(stat -c '%U:%G %a' /etc/pipulse/pipulse.env)" = 'root:pipulse 640' ] && ok 'env mode' || bad 'env mode'
[ "$(stat -c '%U %a' /var/lib/pipulse)" = 'pipulse 700' ] && ok '/var/lib/pipulse mode' || bad '/var/lib/pipulse mode'
grep -q 'no systemd' /tmp/setup.log && ok 'says it skipped the service' || bad 'says it skipped the service'
echo 'PIPULSE_PORT="8889"' >> /etc/pipulse/pipulse.env # quoted, as systemd allows
sh "$here/setup.sh" --no-start >/dev/null 2>&1
grep -q '^PIPULSE_PORT="8889"$' /etc/pipulse/pipulse.env && ok 'keeps an existing env' || bad 'keeps an existing env'
# A process on the configured port produces a warning naming it.
python3 -m http.server 8889 >/dev/null 2>&1 & srv=$!
sleep 1
sh "$here/setup.sh" --no-start 2>&1 | grep -q 'warning: port 8889 is already in use' && ok 'warns about a taken port' || bad 'warns about a taken port'
kill $srv
# ufw active without a rule for the port: a warning with the exact command, nothing changed.
fake=$(mktemp -d)
printf '#!/bin/sh\nprintf "Status: active\\n\\nTo Action From\\n22/tcp ALLOW Anywhere\\n"\n' > "$fake/ufw" && chmod +x "$fake/ufw"
PATH="$fake:$PATH" sh "$here/setup.sh" --no-start 2>&1 | grep -q 'sudo ufw allow from 192.168.1.0/24 to any port 8889 proto tcp' && ok 'warns about a missing ufw rule' || bad 'warns about a missing ufw rule'
exit $fail
