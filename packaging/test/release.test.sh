#!/bin/sh
# Downloading a release (--version / latest): the checksum list must be signed by the key inside
# the installer, and test hooks must do nothing unless PIPULSE_TEST_HOOKS=1.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.3 "$out" >/dev/null
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }

# Two keys: the one the installer trusts, and an impostor's.
trusted=$(mktemp -d); impostor=$(mktemp -d)
GNUPGHOME=$trusted gpg --batch --passphrase '' --quick-gen-key 'PiPulse test <test@example.invalid>' default default never 2>/dev/null
GNUPGHOME=$impostor gpg --batch --passphrase '' --quick-gen-key 'Impostor <x@example.invalid>' default default never 2>/dev/null
GNUPGHOME=$trusted gpg --export > "$out/trusted.gpg"

# release DIR HOME — a downloadable release laid out as on GitHub (DIR/v0.0.3/…), checksums signed with HOME's key.
release() {
  mkdir -p "$1/v0.0.3"
  cp "$out/pipulse-0.0.3.tar.gz" "$1/v0.0.3/"
  (cd "$1/v0.0.3" && sha256sum pipulse-0.0.3.tar.gz > SHA256SUMS && GNUPGHOME=$2 gpg --batch --yes -abs -o SHA256SUMS.asc SHA256SUMS)
}
install_from() { # install_from DIR — the installer against a local release directory
  PIPULSE_TEST_HOOKS=1 PIPULSE_RELEASES_URL="file://$1" PIPULSE_APT_KEY_FILE="$out/trusted.gpg" \
    sh "$repo/packaging/install.sh" --version 0.0.3 --no-start </dev/null >"$out/log" 2>&1
}
installed() { [ -f /opt/pipulse/app/version.json ] && grep -q '"0.0.3"' /opt/pipulse/app/version.json; }

good=$out/good; release "$good" "$trusted"
bad_checksum=$out/bad-checksum; release "$bad_checksum" "$trusted"
printf 'tampered' >> "$bad_checksum/v0.0.3/pipulse-0.0.3.tar.gz"
swapped=$out/swapped; release "$swapped" "$impostor" # a swapped tarball and a matching list, signed by someone else
unsigned=$out/unsigned; release "$unsigned" "$trusted"; rm "$unsigned/v0.0.3/SHA256SUMS.asc"
forged_list=$out/forged-list; release "$forged_list" "$trusted"
printf 'tampered' >> "$forged_list/v0.0.3/pipulse-0.0.3.tar.gz"
(cd "$forged_list/v0.0.3" && sha256sum pipulse-0.0.3.tar.gz > SHA256SUMS) # the list now matches, but its signature does not

refuses() { # refuses NAME DIR
  if install_from "$2"; then bad "$1: a release that does not verify was installed"; else
    if installed || [ -e /opt/pipulse/app ]; then bad "$1: refused, but something was installed"; else ok "$1: refused, nothing installed"; fi
  fi
}
refuses 'a tampered tarball' "$bad_checksum"
refuses 'a swapped tarball with a list signed by another key' "$swapped"
refuses 'a release with no signature' "$unsigned"
refuses 'a list edited to match a tampered tarball' "$forged_list"

if install_from "$good"; then installed && ok 'a release signed by the key inside the installer installs' || bad 'a good release was reported installed but is not'; else cat "$out/log"; bad 'a good release installs'; fi
sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true

# Without the explicit switch the hooks are inert: a stale export must not redirect root.
ran=$(mktemp -u)
hook_check() {
  sed -n '/^hooks()/p;/^hook_value()/,/^}/p;/^force_restart()/p' "$repo/packaging/install.sh" > "$out/hooks.sh"
  PIPULSE_RESTART_CMD="touch $ran" PIPULSE_APT_URL=http://evil.invalid PIPULSE_FORCE_RESTART=1 \
    sh -c ". '$out/hooks.sh'; [ \"\$(hook_value PIPULSE_RESTART_CMD 'systemctl restart pipulse')\" = 'systemctl restart pipulse' ] && [ \"\$(hook_value PIPULSE_APT_URL https://real)\" = https://real ] && ! force_restart"
}
hook_check && ok 'without PIPULSE_TEST_HOOKS=1 the hooks return their defaults' || bad 'a hook was honoured without PIPULSE_TEST_HOOKS=1'
PIPULSE_TEST_HOOKS=1 PIPULSE_RESTART_CMD='echo custom' sh -c ". '$out/hooks.sh'; [ \"\$(hook_value PIPULSE_RESTART_CMD x)\" = 'echo custom' ]" && ok 'with PIPULSE_TEST_HOOKS=1 they work' || bad 'the hooks do not work with PIPULSE_TEST_HOOKS=1'

# A source checkout has no key and refuses to use apt.
if PIPULSE_APT_URL=file:///nonexistent sh "$repo/packaging/install.sh" </dev/null >"$out/log" 2>&1; then bad 'an unstamped installer used apt'; else grep -q 'no signing key' "$out/log" && ok 'an installer with no key stamped in refuses apt' || bad 'the refusal does not say there is no key'; fi
exit $fail
