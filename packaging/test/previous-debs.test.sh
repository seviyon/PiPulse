#!/bin/sh
# previous-debs.sh: only .debs a published release's signed SHA256SUMS vouches for get into the
# apt repository. GitHub is a stub `gh` serving folders; the signing keys are throwaway ones.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }

# key HOME — a new signing key in its own GnuPG home.
key() {
  mkdir -m 700 "$1"
  GNUPGHOME=$1 gpg --batch --passphrase '' --quick-gen-key 'PiPulse test <test@example.invalid>' default default never 2>/dev/null
}
key "$base/ours"
key "$base/theirs"
GNUPGHOME=$base/ours gpg --export > "$base/key.gpg"

# sign TAG [HOME] — (re)writes the release's SHA256SUMS and its signature, as release.yml does.
sign() {
  (cd "$fix/$1" && rm -f SHA256SUMS SHA256SUMS.asc && sha256sum pipulse_*.deb > SHA256SUMS &&
    GNUPGHOME=${2:-$base/ours} gpg --batch --yes -abs -o SHA256SUMS.asc SHA256SUMS)
}
# release VERSION — a published release with one .deb per CPU.
release() {
  mkdir -p "$fix/v$1"
  for a in armhf arm64 amd64; do echo "deb $1 $a" > "$fix/v$1/pipulse_${1}_$a.deb"; done
  sign "v$1"
  echo "v$1" >> "$fix/tags"
}
# fresh — new releases: two to keep, an older one, and the version being released now.
fresh() {
  rm -rf "$base/fix" "$base/out"
  fix=$base/fix
  mkdir -p "$fix" "$base/out"
  : > "$fix/tags"
  # Not in order, and 0.10.0 sorts after 0.9.10 only as a version.
  release 0.10.0
  release 0.9.10
  release 0.10.1
  release 0.10.2
}

mkdir "$base/bin"
cat > "$base/bin/gh" <<'EOF'
#!/bin/sh
[ -z "${GH_FAIL:-}" ] || { echo 'gh: HTTP 502' >&2; exit 1; }
case "$1 $2" in
  'release list') cat "$FIX/tags" ;;
  'release download')
    tag=$3; shift 3
    while [ "$#" -gt 0 ]; do [ "$1" != --dir ] || dir=$2; shift; done
    cp "$FIX/$tag"/* "$dir/" ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$base/bin/gh"

run() { FIX=$fix PATH="$base/bin:$PATH" PIPULSE_APT_KEY=$base/key.gpg sh "$repo/packaging/previous-debs.sh" 0.10.2 "$base/out" 2 >"$base/log" 2>&1; }
got() { find "$base/out" -mindepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' '; }
want='pipulse_0.10.0_amd64.deb pipulse_0.10.0_arm64.deb pipulse_0.10.0_armhf.deb pipulse_0.10.1_amd64.deb pipulse_0.10.1_arm64.deb pipulse_0.10.1_armhf.deb '
# refused NAME REASON — the script fails for that reason and hands over nothing at all.
refused() {
  if run; then bad "$1 (was accepted)"
  elif [ -n "$(got)" ]; then bad "$1 (left $(got))"
  elif grep -q "$2" "$base/log"; then ok "$1"
  else bad "$1 (refused for another reason)"; cat "$base/log"; fi
}

fresh
if run && [ "$(got)" = "$want" ]; then ok 'the two newest earlier releases, not this one'; else bad "the two newest earlier releases, not this one: $(got)"; cat "$base/log"; fi
[ "$(cat "$base/out/pipulse_0.10.1_armhf.deb")" = 'deb 0.10.1 armhf' ] && ok 'the files are the published ones' || bad 'the files are the published ones'

fresh
echo planted > "$fix/v0.10.1/pipulse_9.9.9_amd64.deb"
if run && [ "$(got)" = "$want" ]; then ok 'an extra .deb in a release is not taken'; else bad "an extra .deb in a release is not taken: $(got)"; fi

fresh
echo changed > "$fix/v0.10.0/pipulse_0.10.0_armhf.deb"
refused 'a changed .deb is refused' 'v0.10.0.*does not match'

fresh
sign v0.10.1 "$base/theirs"
refused 'checksums signed by another key are refused' 'v0.10.1.*not signed'

fresh
echo changed > "$fix/v0.10.1/pipulse_0.10.1_amd64.deb"
(cd "$fix/v0.10.1" && sha256sum pipulse_*.deb > SHA256SUMS)
refused 'checksums changed after signing are refused' 'v0.10.1.*not signed'

fresh
rm "$fix/v0.10.1/SHA256SUMS.asc"
refused 'a release without a signature is refused' 'v0.10.1.*not signed'

fresh
(cd "$fix/v0.10.1" && grep -v arm64 SHA256SUMS > s && mv s SHA256SUMS &&
  GNUPGHOME=$base/ours gpg --batch --yes -abs -o SHA256SUMS.asc SHA256SUMS)
refused 'a .deb the signed checksums do not list is refused' 'v0.10.1.*pipulse_0.10.1_arm64.deb is not listed once'

fresh
cp "$fix/v0.10.0"/* "$fix/v0.10.1/"
rm "$fix/v0.10.1"/pipulse_0.10.1_*.deb
refused 'an older release served again under a newer tag is refused' 'v0.10.1.*pipulse_0.10.1_armhf.deb is missing'

fresh
rm "$fix/v0.10.0/pipulse_0.10.0_arm64.deb"
refused 'a release missing a CPU is refused' 'v0.10.0.*pipulse_0.10.0_arm64.deb is missing'

fresh
echo v0.10.2 > "$fix/tags"
if run && [ -z "$(got)" ]; then ok 'nothing earlier: nothing to add'; else bad 'nothing earlier: nothing to add'; cat "$base/log"; fi

fresh
export GH_FAIL=1
refused 'a failing GitHub call stops the release' 'HTTP 502'
unset GH_FAIL
exit $fail
