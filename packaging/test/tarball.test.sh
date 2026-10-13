#!/bin/sh
# The release tarball: built app, production dependencies only, no sources.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.0-test "$out" >/dev/null
tar -tzf "$out/pipulse-0.0.0-test.tar.gz" > "$out/list"
fail=0
for path in pipulse-0.0.0-test/version.json pipulse-0.0.0-test/install.sh \
  pipulse-0.0.0-test/packages/api/dist/server.js pipulse-0.0.0-test/packages/web/dist/index.html \
  pipulse-0.0.0-test/node_modules/fastify/package.json pipulse-0.0.0-test/packaging/setup.sh; do
  if grep -qx "$path" "$out/list"; then echo "ok - has $path"; else echo "not ok - missing $path"; fail=1; fi
done
if grep -q '/node_modules/vitest/' "$out/list"; then echo 'not ok - dev dependency included'; fail=1; else echo 'ok - no dev dependencies'; fi
if grep -q 'packages/[^/]*/src/' "$out/list"; then echo 'not ok - sources included'; fail=1; else echo 'ok - no sources'; fi
if tar -xzf "$out/pipulse-0.0.0-test.tar.gz" -C "$out" && [ -z "$(find "$out/pipulse-0.0.0-test/node_modules" -type d -empty)" ]; then echo 'ok - no empty folders'; else echo 'not ok - empty folders left'; fail=1; fi
if grep -q 'packaging/test/' "$out/list"; then echo 'not ok - packaging tests included'; fail=1; else echo 'ok - no packaging tests'; fi
tar -xzf "$out/pipulse-0.0.0-test.tar.gz" -C "$out" pipulse-0.0.0-test/version.json
grep -q '"version":"0.0.0-test"' "$out/pipulse-0.0.0-test/version.json" && echo 'ok - version stamped' || { echo 'not ok - version stamped'; fail=1; }
# A release (PIPULSE_REQUIRE_WEB_VERSION=1) packs only a dashboard stamped with its own version.
stamp=$repo/packages/web/dist/web-version.txt
saved=$(cat "$stamp" 2>/dev/null || true)
printf 'dev\n' > "$stamp"
if PIPULSE_REQUIRE_WEB_VERSION=1 "$repo/packaging/build-tarball.sh" 0.0.0-test "$out/guard" >"$out/guard.log" 2>&1; then echo 'not ok - an unstamped dashboard was packed for a release'; fail=1; else
  grep -q 'build with PIPULSE_WEB_VERSION=0.0.0-test' "$out/guard.log" && echo 'ok - a release refuses an unstamped dashboard, naming the fix' || { echo 'not ok - the refusal does not name PIPULSE_WEB_VERSION'; fail=1; }
fi
printf '0.0.0-test\n' > "$stamp"
if PIPULSE_REQUIRE_WEB_VERSION=1 "$repo/packaging/build-tarball.sh" 0.0.0-test "$out/guard" >/dev/null 2>&1; then echo 'ok - a release packs a dashboard stamped with its version'; else echo 'not ok - a stamped dashboard was refused'; fail=1; fi
printf '%s\n' "$saved" > "$stamp"
# Built by a non-root user, as on the release runner (uid 1001): the archive must still say root
# for every member, or a tarball install keeps those owners until its late chown.
if [ "$(id -u)" -eq 0 ] && command -v useradd >/dev/null 2>&1; then
  id builder >/dev/null 2>&1 || useradd -m -u 1001 builder
  rm -rf /home/builder/repo && mkdir -p /home/builder/repo
  (cd "$repo" && tar cf - --exclude=.git --exclude=coverage --exclude=out . ) | tar xf - -C /home/builder/repo
  chown -R builder: /home/builder/repo
  mkdir -p /home/builder/out && chown builder: /home/builder/out
  if su builder -c 'cd /home/builder/repo && sh packaging/build-tarball.sh 0.0.0-test /home/builder/out' >/dev/null 2>&1; then
    others=$(tar --numeric-owner -tvzf /home/builder/out/pipulse-0.0.0-test.tar.gz | awk '$2 != "0/0"' | wc -l)
    [ "$others" -eq 0 ] && echo 'ok - a tarball built by uid 1001 is owned by root throughout' || { echo "not ok - $others members are not owned by 0/0 when built as uid 1001"; fail=1; }
  else
    echo 'not ok - build as a non-root user'; fail=1
  fi
else
  echo 'ok - (skipped: the ownership check needs root and useradd)'
fi
exit $fail
