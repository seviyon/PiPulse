#!/bin/sh
# next-version.sh LATEST_TAG BUMP — the next release version (first release: 0.6.0).
# next-version.sh --check VERSION — succeeds only for a plain X.Y.Z version.
# Only plain versions are released: a hyphenated one (0.7.0-rc.1) sorts above
# 0.7.0 in apt, so Pis that installed it would never upgrade to the real 0.7.0.
set -eu
plain() { printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }
if [ "${1:-}" = --check ]; then
  plain "${2:-}" || { echo "not a plain X.Y.Z version: '${2:-}'" >&2; exit 1; }
  exit 0
fi
latest=${1#v} bump=$2
if [ -z "$latest" ]; then echo 0.6.0; exit 0; fi
plain "$latest" || { echo "latest tag is not a plain vX.Y.Z: '$1'" >&2; exit 1; }
IFS=. read -r major minor patch <<EOF
$latest
EOF
case $bump in
  patch) echo "$major.$minor.$((patch + 1))" ;;
  minor) echo "$major.$((minor + 1)).0" ;;
  major) echo "$((major + 1)).0.0" ;;
  *) echo "unknown bump: $bump" >&2; exit 1 ;;
esac
