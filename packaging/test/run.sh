#!/bin/sh
# run.sh [NAME...] — runs packaging/test/NAME.test.sh (default: all, in dependency order).
# run.sh --except NAME... — runs all but the named tests (CI runs verify-release in its own job).
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
all='fetch-node tarball verify-release setup service install release migrate-tls tls rollback deb next-version pr-bump apt migrate'
if [ "${1:-}" = --except ]; then
  shift
  for skip in "$@"; do
    case " $all " in *" $skip "*) ;; *) echo "run.sh: --except $skip: no such test" >&2; exit 2 ;; esac
  done
  keep=
  for name in $all; do
    case " $* " in *" $name "*) ;; *) keep="$keep $name" ;; esac
  done
  # shellcheck disable=SC2086 # the names are fixed words without spaces
  set -- $keep
elif [ "$#" -eq 0 ]; then
  # shellcheck disable=SC2086
  set -- $all
fi
status=0
for name in "$@"; do
  t="$dir/$name.test.sh"
  [ -f "$t" ] || { echo "# $name: no such test (skipped)"; continue; }
  echo "# $name"
  sh "$t" || status=1
done
exit $status
