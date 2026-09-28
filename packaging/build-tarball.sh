#!/bin/sh
# build-tarball.sh VERSION OUT_DIR — packs the built app (run `npm run build` first).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
. "$here/lib.sh"
[ "$#" -eq 2 ] || die "usage: build-tarball.sh VERSION OUT_DIR"
version=$1 out=$2
name="pipulse-$version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="$stage/$name"
mkdir -p "$root/packages" "$out"
cp "$repo/package.json" "$repo/package-lock.json" "$root/"
for pkg in "$repo"/packages/*/; do
  p=$(basename "$pkg")
  [ -d "$pkg/dist" ] || die "packages/$p has no dist/: run npm run build first"
  mkdir -p "$root/packages/$p"
  cp "$pkg/package.json" "$root/packages/$p/"
  cp -R "$pkg/dist" "$root/packages/$p/"
done
(cd "$root" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
cp -R "$here" "$root/packaging"
rm -rf "$root/packaging/test"
cp "$here/install.sh" "$root/install.sh"
printf '{"version":"%s"}\n' "$version" > "$root/version.json"
tar -czf "$out/$name.tar.gz" -C "$stage" "$name"
log "built $out/$name.tar.gz"
