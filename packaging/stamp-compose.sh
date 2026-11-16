#!/bin/sh
# stamp-compose.sh IN OUT VERSION — copies compose.yaml with its image set to that release's tag
# (the repository's copy follows :latest, so until a release finishes its image can be older than
# the file). Used by the release build and, to check what the build handed over, by
# verify-release.sh.
set -eu
[ "$#" -eq 3 ] || { echo 'usage: stamp-compose.sh IN OUT VERSION' >&2; exit 1; }
sed "s#ghcr.io/seviyon/pipulse:latest#ghcr.io/seviyon/pipulse:$3#" "$1" > "$2"
[ "$(grep -c "ghcr.io/seviyon/pipulse:$3" "$2")" -eq 3 ] || { echo "$2 does not name the image $3 three times" >&2; exit 1; }
