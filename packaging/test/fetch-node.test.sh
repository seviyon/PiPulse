#!/bin/sh
# Node download: CPU detection, pinned version, and refusal of anything unverified.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
export PIPULSE_NODE_VERSIONS="$here/node-versions.json"
. "$here/lib.sh"
fail=0
check() { if "$@"; then echo "ok - $name"; else echo "not ok - $name"; fail=1; fi; }

name='maps a 64-bit kernel with 32-bit userland to armhf'
fake=$(mktemp -d)
printf '#!/bin/sh\necho armhf\n' > "$fake/dpkg" && chmod +x "$fake/dpkg"
check sh -c "PATH='$fake':\$PATH; . '$here/lib.sh'; [ \"\$(pipulse_arch)\" = armhf ]"

name='refuses armv6'
check sh -c "! PIPULSE_ARCH=armel sh -c '. \"$here/lib.sh\"; pipulse_arch' 2>/dev/null"

# The container's own CPU, so the fetched Node can run here (amd64 in CI, arm64 on a Mac).
arch=$(pipulse_arch)
version=$(node_version "$arch")

name="fetches and verifies the pinned Node ($arch)"
dest=$(mktemp -d)
check sh -c "'$here/fetch-node.sh' '$arch' '$dest' >/dev/null && '$dest/node/bin/node' --version | grep -qx 'v$version'"

name='refuses a tampered SHASUMS256.txt'
mirror=$(mktemp -d)
mkdir -p "$mirror/v$version"
curl -fsSL "https://nodejs.org/dist/v$version/SHASUMS256.txt" | sed '1s/^./0/' > "$mirror/v$version/SHASUMS256.txt"
curl -fsSL -o "$mirror/v$version/SHASUMS256.txt.sig" "https://nodejs.org/dist/v$version/SHASUMS256.txt.sig"
check sh -c "! PIPULSE_NODE_MIRROR='file://$mirror' '$here/fetch-node.sh' '$arch' '$(mktemp -d)' 2>/dev/null"

name='refuses a list signed by an unknown key'
empty=$(mktemp -d)
check sh -c "! PIPULSE_NODE_KEYRING='$empty/none.kbx' '$here/fetch-node.sh' '$arch' '$(mktemp -d)' 2>/dev/null"

exit $fail
