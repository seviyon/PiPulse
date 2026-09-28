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
exit $fail
