#!/bin/sh
# verify-release.sh: passes on what the release build makes, and fails on each kind of change a
# compromised build job could make to the files it hands over.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
arch=$(dpkg --print-architecture)
v=0.0.9
name=pipulse-$v
base=$(mktemp -d)
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }

# Builds a release folder as release.yml's build job does, but for this CPU only.
good=$base/good
mkdir "$good"
# A release packs only a dashboard stamped with its own version: stamp this build's, then put it back.
stamp=$repo/packages/web/dist/web-version.txt
saved=$(cat "$stamp" 2>/dev/null || true)
printf '%s\n' "$v" > "$stamp"
PIPULSE_REQUIRE_WEB_VERSION=1 sh "$repo/packaging/build-tarball.sh" "$v" "$good" >/dev/null
printf '%s\n' "$saved" > "$stamp"
sh "$repo/packaging/build-deb.sh" "$v" "$arch" "$good/$name.tar.gz" "$good" >/dev/null
sh "$repo/packaging/stamp-installer.sh" "$repo/packaging/install.sh" "$good/install.sh"
sh "$repo/packaging/stamp-compose.sh" "$repo/compose.yaml" "$good/compose.yaml" "$v"

verify() { PIPULSE_VERIFY_ARCHES=$arch sh "$repo/packaging/verify-release.sh" "$v" "$1" >"$base/log" 2>&1; }
# copy_good NAME — a fresh copy of the good release to tamper with.
copy_good() { rm -rf "${base:?}/$1"; cp -R "$good" "$base/$1"; }
# repack NAME — unpack the tarball into $base/NAME-t, run the caller's change in it, repack.
unpack() { rm -rf "$base/t"; mkdir "$base/t"; tar -xzf "$base/$1/$name.tar.gz" -C "$base/t"; }
repack() { tar -czf "$base/$1/$name.tar.gz" -C "$base/t" "$name"; }
expect_fail() { # expect_fail DESCRIPTION DIR
  if verify "$base/$2"; then bad "$1 (was accepted)"; else ok "$1"; fi
}

verify "$good" && ok 'what the build makes passes' || { bad 'what the build makes passes'; cat "$base/log"; }

copy_good a; echo '# extra' >> "$base/a/install.sh"
expect_fail 'a changed install.sh is refused' a

copy_good b; sed -i "s#pipulse:$v#pipulse:evil#" "$base/b/compose.yaml"
expect_fail 'a changed compose.yaml is refused' b

copy_good c; echo x > "$base/c/extra.txt"
expect_fail 'an extra file is refused' c

copy_good d; unpack d; echo 'exit 0' >> "$base/t/$name/packaging/setup.sh"; repack d
expect_fail 'a changed packaging script in the tarball is refused' d

copy_good e; unpack e; echo '// x' >> "$base/t/$name/node_modules/fastify/fastify.js"; repack e
expect_fail 'a changed dependency in the tarball is refused' e

copy_good f; unpack f; mkdir "$base/t/$name/node_modules/evil"; echo '{"name":"evil","version":"1.0.0"}' > "$base/t/$name/node_modules/evil/package.json"; repack f
expect_fail 'an extra dependency in the tarball is refused' f

copy_good g; unpack g; echo '{"version":"9.9.9"}' > "$base/t/$name/version.json"; repack g
expect_fail 'a changed version.json is refused' g

copy_good h; unpack h; echo ' ' >> "$base/t/$name/packages/api/package.json"; repack h
expect_fail 'a changed package.json is refused' h

# A .deb changed after the tarball: rebuilt from the same (good) tarball, it must differ.
copy_good i
rm -rf "$base/deb"; mkdir "$base/deb"
dpkg-deb -R "$base/i/pipulse_${v}_$arch.deb" "$base/deb"
echo 'touch /tmp/evil' >> "$base/deb/DEBIAN/postinst"
dpkg-deb -Zxz --root-owner-group --build "$base/deb" "$base/i/pipulse_${v}_$arch.deb" >/dev/null
expect_fail 'a changed maintainer script in the .deb is refused' i

copy_good j
rm -rf "$base/deb"; mkdir "$base/deb"
dpkg-deb -R "$base/j/pipulse_${v}_$arch.deb" "$base/deb"
echo '// x' >> "$base/deb/opt/pipulse/app/node_modules/fastify/fastify.js"
dpkg-deb -Zxz --root-owner-group --build "$base/deb" "$base/j/pipulse_${v}_$arch.deb" >/dev/null
expect_fail 'a changed file inside the .deb is refused' j

copy_good k
rm -rf "$base/deb"; mkdir "$base/deb"
dpkg-deb -R "$base/k/pipulse_${v}_$arch.deb" "$base/deb"
echo 'evil' > "$base/deb/opt/pipulse/node/bin/node"
dpkg-deb -Zxz --root-owner-group --build "$base/deb" "$base/k/pipulse_${v}_$arch.deb" >/dev/null
expect_fail 'a changed Node binary in the .deb is refused' k

# Known and documented: the compiled application is not checked (only the project's build can make it).
copy_good l; unpack l; echo '// x' >> "$base/t/$name/packages/api/dist/server.js"; repack l
# A real change would reach the .deb too, so rebuild it from the changed tarball.
sh "$repo/packaging/build-deb.sh" "$v" "$arch" "$base/l/$name.tar.gz" "$base/l" >/dev/null
if verify "$base/l"; then ok 'the compiled dist is not verified (documented limit)'; else bad 'the compiled dist is not verified (documented limit)'; fi

rm -rf "$base"
exit $fail
