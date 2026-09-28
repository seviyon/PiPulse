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
if grep -q 'packaging/test/' "$out/list"; then echo 'not ok - packaging tests included'; fail=1; else echo 'ok - no packaging tests'; fi
tar -xzf "$out/pipulse-0.0.0-test.tar.gz" -C "$out" pipulse-0.0.0-test/version.json
grep -q '"version":"0.0.0-test"' "$out/pipulse-0.0.0-test/version.json" && echo 'ok - version stamped' || { echo 'not ok - version stamped'; fail=1; }
exit $fail
