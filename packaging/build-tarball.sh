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
# A release must pack a dashboard that knows its own version (the page warns when it no longer
# matches the server): the release builds with PIPULSE_WEB_VERSION and sets this.
if [ "${PIPULSE_REQUIRE_WEB_VERSION:-}" = 1 ]; then
  stamped=$(cat "$repo/packages/web/dist/web-version.txt" 2>/dev/null || true)
  [ "$stamped" = "$version" ] || die "the dashboard in packages/web/dist is stamped '${stamped:-nothing}', not $version: build with PIPULSE_WEB_VERSION=$version"
fi
(cd "$root" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
# npm leaves empty scope folders behind for the development packages it skipped.
find "$root/node_modules" -type d -empty -delete
cp -R "$here" "$root/packaging"
rm -rf "$root/packaging/test"
# The installer carries the signing key it trusts (also the copy inside packaging/).
sh "$here/stamp-installer.sh" "$here/install.sh" "$root/install.sh"
cp "$root/install.sh" "$root/packaging/install.sh"
printf '{"version":"%s"}\n' "$version" > "$root/version.json"
# No extended attributes: macOS tar would add its own (com.apple.provenance),
# which GNU tar on the Pi warns about for every file.
# Every member is owned by root:root whoever builds it: the release runner is uid 1001, and an
# installer that kept those owners would leave /opt/pipulse writable by a local user 1001 until
# its chown. GNU tar and bsdtar (macOS) spell the options differently.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  owner='--owner=0 --group=0 --numeric-owner'
else
  owner='--uid 0 --gid 0 --uname root --gname root'
fi
# shellcheck disable=SC2086 # the options are words on purpose
COPYFILE_DISABLE=1 tar --no-xattrs $owner -czf "$out/$name.tar.gz" -C "$stage" "$name"
log "built $out/$name.tar.gz"
