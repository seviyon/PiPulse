#!/bin/sh
# next-version.sh LATEST_TAG BUMP — the next release version (first release: 0.6.0).
set -eu
latest=${1#v} bump=$2
if [ -z "$latest" ]; then echo 0.6.0; exit 0; fi
IFS=. read -r major minor patch <<EOF
$latest
EOF
case $bump in
  patch) echo "$major.$minor.$((patch + 1))" ;;
  minor) echo "$major.$((minor + 1)).0" ;;
  major) echo "$((major + 1)).0.0" ;;
  *) echo "unknown bump: $bump" >&2; exit 1 ;;
esac
