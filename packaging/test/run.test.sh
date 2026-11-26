#!/bin/sh
# run.sh itself: no packaging test may be dropped without CI noticing. Each case runs a
# copy of run.sh in a scratch folder with stand-in tests that only record their name.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
log="$work/log"
names=$(sed -n "s/^all='\(.*\)'\$/\1/p" "$here/run.sh")

fresh() {
  rm -rf "$work/t"; mkdir -p "$work/t"; : > "$log"
  cp "$here/run.sh" "$work/t/run.sh"
  for name in $names; do
    printf 'echo %s >> "%s"\n' "$name" "$log" > "$work/t/$name.test.sh"
  done
}
# edit SED-SCRIPT: changes the copied run.sh and insists that something changed.
edit() {
  sed "$1" "$work/t/run.sh" > "$work/edited"
  if cmp -s "$work/edited" "$work/t/run.sh"; then bad "the edit $1 changed nothing"; fi
  cp "$work/edited" "$work/t/run.sh"
}
run() { sh "$work/t/run.sh" "$@" > "$work/out" 2>&1; }
ran() { sort "$log" | tr '\n' ' '; }
words() { printf '%s\n' "$@" | sort | tr '\n' ' '; }
# refuses WHAT MESSAGE ARGS...: run.sh fails, says MESSAGE and runs no test.
refuses() {
  what=$1; message=$2; shift 2
  : > "$log"
  if run "$@"; then bad "$what: run.sh succeeded"
  elif ! grep -qF -- "$message" "$work/out"; then bad "$what: no '$message' in: $(cat "$work/out")"
  elif [ -s "$log" ]; then bad "$what: tests ran: $(ran)"
  else ok "$what"
  fi
}

fresh
# shellcheck disable=SC2086 # the names are fixed words without spaces
run && [ "$(ran)" = "$(words $names)" ] && ok 'no argument runs every test' || bad "no argument: $(cat "$work/out") ran: $(ran)"

# The two shards and the verify-release job together are every test, each exactly once.
fresh
run --shard 1 && run --shard 2 && run verify-release || bad "a shard failed: $(cat "$work/out")"
# shellcheck disable=SC2086
[ "$(ran)" = "$(words $names)" ] && ok 'shard 1, shard 2 and verify-release run each test once' || bad "shards ran: $(ran)"

fresh
run --except verify-release && ! grep -qx verify-release "$log" && [ "$(wc -l < "$log")" -eq "$(($(echo "$names" | wc -w) - 1))" ] && ok '--except leaves out only that test' || bad "--except ran: $(ran)"

fresh
echo 'exit 1' > "$work/t/deb.test.sh"
if run --shard 2; then bad 'a failing test fails its shard'
elif grep -qx migrate "$log"; then ok 'a failing test fails its shard and the rest still run'
else bad "the shard stopped at the failure: $(ran)"
fi

fresh
: > "$work/t/forgotten.test.sh"
refuses 'a test file that is not in the list' 'forgotten.test.sh is not in the list' --shard 1
refuses 'an unlisted file also stops the verify-release job' 'forgotten.test.sh is not in the list' verify-release

fresh
rm "$work/t/deb.test.sh"
refuses 'a listed test with no file' 'deb is listed but has no deb.test.sh' --shard 1

fresh
edit "s/^\(shard2='.*\) deb /\1 /"
refuses 'a test in no shard' 'deb must be in exactly one' --shard 1

fresh
edit "s/^shard1='/shard1='deb /"
refuses 'a test in two shards' 'deb must be in exactly one' --shard 2

fresh
edit "s/^shard1='/shard1='nothing /"
refuses 'a shard naming an unknown test' 'nothing is in a shard but not in the list' --shard 1

fresh
refuses 'an unknown shard' 'no such shard' --shard 3
refuses 'an unknown test name' 'no such test' nothing
refuses 'an unknown --except name' 'no such test' --except nothing

exit $fail
