#!/bin/sh
# run.sh [NAME...] — runs packaging/test/NAME.test.sh (default: all, in dependency order).
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
[ "$#" -gt 0 ] || set -- fetch-node tarball setup service install migrate-tls tls rollback deb next-version apt migrate
status=0
for name in "$@"; do
  t="$dir/$name.test.sh"
  [ -f "$t" ] || { echo "# $name: no such test (skipped)"; continue; }
  echo "# $name"
  sh "$t" || status=1
done
exit $status
