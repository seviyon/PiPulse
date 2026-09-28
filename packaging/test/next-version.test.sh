#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
fail=0
t() { got=$(sh "$here/next-version.sh" "$1" "$2"); [ "$got" = "$3" ] && echo "ok - '$1' $2 → $3" || { echo "not ok - '$1' $2 → $got, want $3"; fail=1; }; }
t '' patch 0.6.0
t '' minor 0.6.0
t v0.6.0 patch 0.6.1
t v0.6.1 minor 0.7.0
t v0.7.3 major 1.0.0
# Only plain X.Y.Z versions: a hyphenated one (0.7.0-rc.1) sorts above 0.7.0 in apt,
# so Pis that installed it would never upgrade to the real 0.7.0.
for bad in v0.7.0-rc.1 v1.2 banana; do
  if sh "$here/next-version.sh" "$bad" patch >/dev/null 2>&1; then echo "not ok - refuses tag '$bad'"; fail=1; else echo "ok - refuses tag '$bad'"; fi
done
for bad in 0.7.0-rc.1 0.7 ''; do
  if sh "$here/next-version.sh" --check "$bad" >/dev/null 2>&1; then echo "not ok - refuses version '$bad'"; fail=1; else echo "ok - refuses version '$bad'"; fi
done
sh "$here/next-version.sh" --check 0.7.0 >/dev/null && echo 'ok - accepts 0.7.0' || { echo 'not ok - accepts 0.7.0'; fail=1; }
exit $fail
