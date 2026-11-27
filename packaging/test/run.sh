#!/bin/sh
# run.sh [NAME...] — runs packaging/test/NAME.test.sh (default: all, in dependency order).
# run.sh --except NAME... — runs all but the named tests.
# run.sh --shard 1|2 — runs one of CI's two shards. verify-release runs in its own CI job.
# A new test goes in `all` and in one shard; every call checks that before running anything.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
all='fetch-node tarball verify-release setup service install release migrate-tls tls rollback deb next-version pr-bump previous-debs apt migrate run'
# Split by duration, so that the two take about as long as each other.
shard1='fetch-node tarball setup service install release migrate-tls rollback'
shard2='tls deb next-version pr-bump previous-debs apt migrate run'
own_job='verify-release'

die() { echo "run.sh: $1" >&2; exit 2; }
listed() { case " $all " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# The list, the files and the shards must agree, or a test could stop running unnoticed.
for t in "$dir"/*.test.sh; do
  name=${t##*/}; name=${name%.test.sh}
  listed "$name" || die "$name.test.sh is not in the list"
done
for name in $all; do
  [ -f "$dir/$name.test.sh" ] || die "$name is listed but has no $name.test.sh"
  places=0
  for placed in $shard1 $shard2 $own_job; do
    [ "$placed" != "$name" ] || places=$((places + 1))
  done
  [ "$places" -eq 1 ] || die "$name must be in exactly one of shard1, shard2 and own_job (found $places)"
done
for name in $shard1 $shard2 $own_job; do
  listed "$name" || die "$name is in a shard but not in the list"
done

if [ "${1:-}" = --except ]; then
  shift
  for skip in "$@"; do
    listed "$skip" || die "--except $skip: no such test"
  done
  keep=
  for name in $all; do
    case " $* " in *" $name "*) ;; *) keep="$keep $name" ;; esac
  done
  # shellcheck disable=SC2086 # the names are fixed words without spaces
  set -- $keep
elif [ "${1:-}" = --shard ]; then
  # shellcheck disable=SC2086
  case "$#:${2:-}" in
    2:1) set -- $shard1 ;;
    2:2) set -- $shard2 ;;
    *) die "--shard ${2:-}: no such shard" ;;
  esac
elif [ "$#" -eq 0 ]; then
  # shellcheck disable=SC2086
  set -- $all
fi
for name in "$@"; do
  listed "$name" || die "$name: no such test"
done
status=0
for name in "$@"; do
  echo "# $name"
  sh "$dir/$name.test.sh" || status=1
done
exit $status
