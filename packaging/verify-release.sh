#!/bin/sh
# verify-release.sh VERSION OUT_DIR — checks the files the release's build job handed over against
# the commit being released, before anything is signed. The build job runs npm and the project's
# tooling, so whatever it leaves in OUT_DIR is only as trustworthy as that tooling; this script
# rebuilds, from the checkout alone, everything that does not need the project's own build, and
# compares:
#   install.sh, compose.yaml     rebuilt from the checkout, byte for byte;
#   the tarball                  its file list, package.json/lock files, packaging/ and version.json
#                                against the checkout, and node_modules against a fresh
#                                `npm ci --omit=dev --ignore-scripts` of the checked-out lockfile
#                                (npm unpacks packages whose integrity the lockfile pins; no
#                                dependency code runs);
#   each .deb                    rebuilt from the verified tarball with a freshly downloaded Node
#                                and compared member by member.
# NOT verified: packages/*/dist, the compiled application, which only the project's own build can
# make. A compromised build tool can still change it; the pinned, age-gated dependencies and
# review are the defence there. Exit 0 only when nothing differs.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
. "$here/lib.sh"
[ "$#" -eq 2 ] || die "usage: verify-release.sh VERSION OUT_DIR"
version=$1 out=$2
name="pipulse-$version"
# The release ships all three; the test suite builds only its own CPU's.
arches=${PIPULSE_VERIFY_ARCHES:-armhf arm64 amd64}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0
bad() { printf '[pipulse] MISMATCH: %s\n' "$*" >&2; fail=1; }
ok() { log "ok: $*"; }
# names DIR — what DIR holds, sorted, on one line.
names() { find "$1" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | LC_ALL=C sort | tr '\n' ' '; }

# 1. Nothing but the expected files.
have=$(names "$out")
want_sorted=$({ printf '%s\n' compose.yaml install.sh "$name.tar.gz"; for a in $arches; do echo "pipulse_${version}_$a.deb"; done; } | LC_ALL=C sort | tr '\n' ' ')
[ "$have" = "$want_sorted" ] && ok 'the release holds exactly the expected files' || bad "files in $out: $have, expected $want_sorted"

# 2. install.sh and compose.yaml.
sh "$here/stamp-installer.sh" "$here/install.sh" "$work/install.sh"
cmp -s "$work/install.sh" "$out/install.sh" && ok 'install.sh is the checkout stamped with the committed key' || bad 'install.sh differs from the checkout stamped with packaging/apt-key.gpg'
sh "$here/stamp-compose.sh" "$repo/compose.yaml" "$work/compose.yaml" "$version"
cmp -s "$work/compose.yaml" "$out/compose.yaml" && ok 'compose.yaml is the checkout with this release tag' || bad 'compose.yaml differs from the checkout'

# 3. The tarball.
mkdir "$work/t"
tar -xzf "$out/$name.tar.gz" -C "$work/t"
t="$work/t/$name"
members=$(names "$work/t")
[ "$members" = "$name " ] || bad "the tarball's top level is: $members"
top=$(names "$t")
[ "$top" = 'install.sh node_modules package-lock.json package.json packages packaging version.json ' ] && ok 'tarball top level' || bad "tarball top level: $top"
for f in package.json package-lock.json; do
  cmp -s "$repo/$f" "$t/$f" && ok "tarball $f" || bad "tarball $f differs from the checkout"
done
printf '{"version":"%s"}\n' "$version" > "$work/version.json"
cmp -s "$work/version.json" "$t/version.json" && ok 'tarball version.json' || bad 'tarball version.json'
cmp -s "$work/install.sh" "$t/install.sh" && cmp -s "$work/install.sh" "$t/packaging/install.sh" && ok 'tarball install.sh copies' || bad 'an install.sh inside the tarball differs'
cp -R "$here" "$work/packaging"
rm -rf "$work/packaging/test"
cp "$work/install.sh" "$work/packaging/install.sh"
diff -r --no-dereference "$work/packaging" "$t/packaging" >"$work/diff.txt" 2>&1 && ok 'tarball packaging/' || { bad 'tarball packaging/ differs from the checkout'; head -n 20 "$work/diff.txt" >&2; }
# packages/*: only package.json and dist; package.json from the checkout. dist is not verifiable here.
for pkg in "$repo"/packages/*/; do
  p=$(basename "$pkg")
  [ "$(names "$t/packages/$p")" = 'dist package.json ' ] || bad "packages/$p holds more or less than dist and package.json"
  cmp -s "$pkg/package.json" "$t/packages/$p/package.json" || bad "packages/$p/package.json differs from the checkout"
done
[ "$(names "$t/packages")" = "$(names "$repo/packages")" ] || bad 'the tarball holds a different set of packages'
# node_modules: what npm makes of the checked-out lockfile.
mkdir "$work/n"
cp "$repo/package.json" "$repo/package-lock.json" "$work/n/"
for pkg in "$repo"/packages/*/; do
  p=$(basename "$pkg")
  mkdir -p "$work/n/packages/$p"
  cp "$pkg/package.json" "$work/n/packages/$p/"
done
(cd "$work/n" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && find node_modules -type d -empty -delete)
diff -r --no-dereference "$work/n/node_modules" "$t/node_modules" >"$work/diff.txt" 2>&1 && ok 'tarball node_modules match the lockfile' || { bad 'tarball node_modules differ from the lockfile'; head -n 20 "$work/diff.txt" >&2; }

# 4. The .debs, rebuilt from the tarball just checked (and a freshly downloaded, GPG-verified Node).
tree() { (cd "$1" && find . -printf '%M %P %l\n' | LC_ALL=C sort); }
for arch in $arches; do
  mkdir "$work/new-$arch"
  sh "$here/build-deb.sh" "$version" "$arch" "$out/$name.tar.gz" "$work/new-$arch" >/dev/null
  for which in shipped rebuilt; do
    if [ "$which" = shipped ]; then src="$out/pipulse_${version}_$arch.deb"; else src="$work/new-$arch/pipulse_${version}_$arch.deb"; fi
    mkdir "$work/$which-$arch" "$work/$which-$arch-control"
    dpkg-deb -x "$src" "$work/$which-$arch"
    dpkg-deb -e "$src" "$work/$which-$arch-control"
    # The changelog carries the build date, and Installed-Size depends on its compressed size.
    rm -f "$work/$which-$arch"/usr/share/doc/pipulse/changelog*.gz
    sed -i '/^Installed-Size:/d' "$work/$which-$arch-control/control"
  done
  d="pipulse_${version}_$arch.deb"
  diff -r --no-dereference "$work/rebuilt-$arch" "$work/shipped-$arch" >"$work/diff.txt" 2>&1 && diff -r "$work/rebuilt-$arch-control" "$work/shipped-$arch-control" >>"$work/diff.txt" 2>&1 \
    && [ "$(tree "$work/rebuilt-$arch")" = "$(tree "$work/shipped-$arch")" ] \
    && ok "$d matches a rebuild from the checkout" || { bad "$d differs from a rebuild from the checkout"; head -n 20 "$work/diff.txt" >&2; }
done
exit "$fail"
