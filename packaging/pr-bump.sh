#!/bin/sh
# pr-bump.sh SHA — reads the GitHub API's pull requests for a commit (GET /commits/SHA/pulls) on
# stdin and prints the release bump (patch, minor or major) that the merged PR for exactly that
# commit asks for; prints nothing when there is none. Only a PR that was merged AS that commit
# counts: a PR that merely contains the commit, or one closed without merging, never releases.
# With several release labels the lexicographically last wins (patch over minor over major),
# as the workflow always chose.
set -eu
sha=${1:?usage: pr-bump.sh SHA < pulls.json}
jq -r --arg sha "$sha" \
  '.[] | select(.merge_commit_sha == $sha and .merged_at != null) | .labels[].name' |
  { grep -E '^release:(patch|minor|major)$' || true; } | sed 's/^release://' | sort | tail -n 1
