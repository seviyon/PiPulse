#!/bin/sh
# fetch-node.sh ARCH DEST — downloads the pinned Node for ARCH into DEST/node,
# verifying SHASUMS256.txt's signature with the Node release keys first.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
[ "$#" -eq 2 ] || die "usage: fetch-node.sh ARCH DEST"
arch=$1 dest=$2
version=$(PIPULSE_NODE_VERSIONS="$here/node-versions.json" node_version "$arch")
[ -n "$version" ] || die "no Node version pinned for $arch"
mirror=${PIPULSE_NODE_MIRROR:-https://nodejs.org/dist}
keyring=${PIPULSE_NODE_KEYRING:-$here/node-keys/pubring.kbx}
file="node-v$version-linux-$(node_dist "$arch").tar.xz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/SHASUMS256.txt" "$mirror/v$version/SHASUMS256.txt"
curl -fsSL -o "$work/SHASUMS256.txt.sig" "$mirror/v$version/SHASUMS256.txt.sig"
gpgv --keyring "$keyring" "$work/SHASUMS256.txt.sig" "$work/SHASUMS256.txt" 2>/dev/null ||
  die "Node $version: SHASUMS256.txt is not signed by a Node release key"
curl -fsSL -o "$work/$file" "$mirror/v$version/$file"
(cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) ||
  die "Node $version: $file does not match its signed checksum"
mkdir -p "$dest/node"
# PiPulse needs only the node binary (its dependencies ship installed): leave out
# npm, corepack, headers and docs.
tar -xJf "$work/$file" -C "$work"
mkdir -p "$dest/node/bin"
cp "$work/${file%.tar.xz}/bin/node" "$dest/node/bin/node"
cp "$work/${file%.tar.xz}/LICENSE" "$dest/node/LICENSE"
log "Node $version ($arch) verified"
