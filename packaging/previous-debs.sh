#!/bin/sh
# previous-debs.sh VERSION OUT_DIR KEEP — fetches the .debs of the KEEP newest published releases
# other than VERSION into OUT_DIR, for the apt repository to carry beside the new one. Every .deb
# must be listed in its release's SHA256SUMS, signed by the key in packaging/apt-key.gpg, and match
# it; anything else stops the release with OUT_DIR untouched.
#
# The release builds the apt repository from these and the new build only, never from what the
# gh-pages branch holds: whoever could push there would otherwise get a package of their own
# indexed and signed by the next release. Needs `gh` (GH_TOKEN) and gpgv.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
[ "$#" -eq 3 ] || die "usage: previous-debs.sh VERSION OUT_DIR KEEP"
version=$1 out=$2 keep=$3
keyring=${PIPULSE_APT_KEY:-$here/apt-key.gpg}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/verified"

# On its own line: if the call fails the script fails, instead of reading as "no earlier release".
tags=$(gh release list --limit 100 --exclude-drafts --exclude-pre-releases --json tagName --jq '.[].tagName')
previous=$(printf '%s\n' "$tags" | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } |
  { grep -Fvx "v$version" || true; } | sort -rV | head -n "$keep")

for tag in $previous; do
  v=${tag#v}
  dir=$work/$tag
  mkdir "$dir"
  gh release download "$tag" --dir "$dir" --pattern 'pipulse_*.deb' --pattern SHA256SUMS --pattern SHA256SUMS.asc
  gpgv --keyring "$keyring" "$dir/SHA256SUMS.asc" "$dir/SHA256SUMS" >/dev/null 2>&1 ||
    die "$tag: SHA256SUMS is not signed by the PiPulse release key"
  # The names carry the version, and the signature covers names and checksums together, so an older
  # release's files served under this tag are not listed under the names asked for.
  for arch in armhf arm64 amd64; do
    deb=pipulse_${v}_$arch.deb
    [ -f "$dir/$deb" ] || die "$tag: $deb is missing"
    awk -v name="$deb" '$2 == name' "$dir/SHA256SUMS" > "$work/sum"
    [ "$(grep -c . "$work/sum")" -eq 1 ] || die "$tag: $deb is not listed once in SHA256SUMS"
    (cd "$dir" && sha256sum -c "$work/sum" >/dev/null 2>&1) || die "$tag: $deb does not match SHA256SUMS"
    cp "$dir/$deb" "$work/verified/"
  done
  log "ok: $tag"
done

mkdir -p "$out"
for f in "$work"/verified/*.deb; do
  [ ! -e "$f" ] || cp "$f" "$out/"
done
