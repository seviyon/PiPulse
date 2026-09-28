#!/bin/sh
# The apt repository: signed indexes apt accepts, newest version offered, old ones pruned.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
apt-get purge -y pipulse >/dev/null 2>&1 || true
arch=$(dpkg --print-architecture)
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
"$repo/packaging/build-tarball.sh" 0.0.2 "$out" >/dev/null
"$repo/packaging/build-deb.sh" 0.0.1 "$arch" "$out/pipulse-0.0.1.tar.gz" "$out" >/dev/null
"$repo/packaging/build-deb.sh" 0.0.2 "$arch" "$out/pipulse-0.0.2.tar.gz" "$out" >/dev/null
# A throwaway signing key, as the release's secret key would be.
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
gpg --batch --passphrase '' --quick-gen-key 'PiPulse test <test@example.invalid>' default default never 2>/dev/null
apt_dir=$(mktemp -d)
fail=0
sh "$repo/packaging/apt-publish.sh" "$apt_dir" 1 "$out/pipulse_0.0.1_$arch.deb" >/dev/null
sh "$repo/packaging/apt-publish.sh" "$apt_dir" 1 "$out/pipulse_0.0.2_$arch.deb" >/dev/null
# apt downloads as the unprivileged _apt user; mktemp folders are root-only.
chmod -R a+rX "$apt_dir"
cp "$apt_dir/pipulse.gpg" /usr/share/keyrings/pipulse-test.gpg
echo "deb [signed-by=/usr/share/keyrings/pipulse-test.gpg] file://$apt_dir stable main" > /etc/apt/sources.list.d/pipulse-test.list
apt-get update -qq 2>/tmp/apt.err || true; cat /tmp/apt.err >&2
if ! grep -q . /tmp/apt.err && ! grep -q 'NO_PUBKEY\|not signed\|BADSIG' /tmp/apt.err; then echo 'ok - signed index accepted'; else cat /tmp/apt.err; echo 'not ok - signed index accepted'; fail=1; fi
candidate=$(apt-cache policy pipulse | sed -n 's/ *Candidate: //p')
[ "$candidate" = 0.0.2 ] && echo 'ok - newest version offered' || { echo "not ok - newest version offered (got $candidate)"; fail=1; }
[ "$(find "$apt_dir/pool/main" -name '*.deb' | wc -l)" -eq 1 ] && echo 'ok - kept only the newest' || { echo 'not ok - kept only the newest'; fail=1; }
# A repository signed by another key must be refused.
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
gpg --batch --passphrase '' --quick-gen-key 'Someone else <x@example.invalid>' default default never 2>/dev/null
sh "$repo/packaging/apt-publish.sh" "$apt_dir" 1 "$out/pipulse_0.0.2_$arch.deb" >/dev/null
chmod -R a+rX "$apt_dir"
rm -rf /var/lib/apt/lists/*pipulse* /var/lib/apt/lists/_tmp_*
if apt-get update -qq 2>&1 | grep -q 'NO_PUBKEY\|is not signed\|invalid'; then echo 'ok - another key is refused'; else echo 'not ok - another key is refused'; fail=1; fi
rm -f /etc/apt/sources.list.d/pipulse-test.list /usr/share/keyrings/pipulse-test.gpg
exit $fail
