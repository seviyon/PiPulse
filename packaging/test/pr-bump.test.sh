#!/bin/sh
# pr-bump.sh: which merged PR, for which commit, asks for which release.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
fail=0
t() { # t NAME SHA WANT JSON
  got=$(printf '%s' "$4" | sh "$here/pr-bump.sh" "$2")
  [ "$got" = "$3" ] && echo "ok - $1" || { echo "not ok - $1: got '$got', want '$3'"; fail=1; }
}
M='"merged_at":"2026-11-16T10:00:00Z"'
t 'patch label' abc patch "[{\"merge_commit_sha\":\"abc\",$M,\"labels\":[{\"name\":\"release:patch\"}]}]"
t 'minor label among others' abc minor "[{\"merge_commit_sha\":\"abc\",$M,\"labels\":[{\"name\":\"bug\"},{\"name\":\"release:minor\"}]}]"
t 'no release label' abc '' "[{\"merge_commit_sha\":\"abc\",$M,\"labels\":[{\"name\":\"bug\"}]}]"
t 'no labels at all' abc '' "[{\"merge_commit_sha\":\"abc\",$M,\"labels\":[]}]"
t 'no PR for the commit (direct push)' abc '' '[]'
t 'PR merged as another commit' abc '' "[{\"merge_commit_sha\":\"zzz\",$M,\"labels\":[{\"name\":\"release:patch\"}]}]"
t 'PR closed without merging' abc '' '[{"merge_commit_sha":"abc","merged_at":null,"labels":[{"name":"release:patch"}]}]'
t 'a lookalike label is not a release' abc '' "[{\"merge_commit_sha\":\"abc\",$M,\"labels\":[{\"name\":\"release:patchy\"},{\"name\":\"no-release:patch\"},{\"name\":\"release:bogus\"}]}]"
t 'the PR for the commit is picked among several' abc major "[{\"merge_commit_sha\":\"zzz\",$M,\"labels\":[{\"name\":\"release:patch\"}]},{\"merge_commit_sha\":\"abc\",$M,\"labels\":[{\"name\":\"release:major\"}]}]"
t 'two release labels: patch wins, as before' abc patch "[{\"merge_commit_sha\":\"abc\",$M,\"labels\":[{\"name\":\"release:major\"},{\"name\":\"release:patch\"}]}]"
if printf '[]' | sh "$here/pr-bump.sh" 2>/dev/null; then echo 'not ok - needs a SHA'; fail=1; else echo 'ok - needs a SHA'; fi
exit $fail
