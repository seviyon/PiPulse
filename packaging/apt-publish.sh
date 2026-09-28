#!/bin/sh
# apt-publish.sh REPO_DIR KEEP DEB... — add DEBs to the apt repo, keep the newest
# KEEP per architecture, regenerate and sign the indexes (key: GPG default key;
# passphrase on stdin when APT_SIGNING_PASSPHRASE is set).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
repo=$1 keep=$2
shift 2
mkdir -p "$repo/pool/main"
cp "$@" "$repo/pool/main/"
for arch in armhf arm64 amd64; do
  # shellcheck disable=SC2012
  ls "$repo/pool/main"/pipulse_*_"$arch".deb 2>/dev/null | sort -V | head -n "-$keep" | xargs -r rm -f
done
cd "$repo"
for arch in armhf arm64 amd64; do
  d="dists/stable/main/binary-$arch"
  mkdir -p "$d"
  apt-ftparchive --arch "$arch" packages pool/main > "$d/Packages"
  gzip -9fk "$d/Packages"
done
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=PiPulse -o APT::FTPArchive::Release::Label=PiPulse \
  -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures='armhf arm64 amd64' -o APT::FTPArchive::Release::Components=main \
  release dists/stable > dists/stable/Release
sign() { if [ -n "${APT_SIGNING_PASSPHRASE:-}" ]; then printf '%s' "$APT_SIGNING_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 "$@"; else gpg --batch --yes "$@"; fi; }
sign --clearsign -o dists/stable/InRelease dists/stable/Release
sign -abs -o dists/stable/Release.gpg dists/stable/Release
gpg --export > pipulse.gpg
log "apt repository updated in $repo"
