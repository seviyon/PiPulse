#!/bin/sh
# build-deb.sh VERSION ARCH TARBALL OUT_DIR — the .deb for one CPU (with its Node).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
[ "$#" -eq 4 ] || die "usage: build-deb.sh VERSION ARCH TARBALL OUT_DIR"
version=$1 arch=$2 tarball=$3 out=$4
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/DEBIAN" "$root/opt/pipulse" "$root/usr/bin" "$root/lib/systemd/system" "$root/etc/pipulse" "$root/usr/share/doc/pipulse"
tar -xzf "$tarball" -C "$root/opt/pipulse"
mv "$root/opt/pipulse/pipulse-$version" "$root/opt/pipulse/app"
sh "$here/fetch-node.sh" "$arch" "$root/opt/pipulse"
install -m 755 "$here/pipulse" "$root/usr/bin/pipulse"
install -m 644 "$here/pipulse.service" "$root/lib/systemd/system/pipulse.service"
install -m 644 "$here/pipulse-tls-renew.service" "$root/lib/systemd/system/pipulse-tls-renew.service"
install -m 644 "$here/pipulse-tls-renew.timer" "$root/lib/systemd/system/pipulse-tls-renew.timer"
install -m 640 "$here/pipulse.env" "$root/etc/pipulse/pipulse.env"
install -m 644 "$here/deb/copyright" "$root/usr/share/doc/pipulse/copyright"
# Debian wants a changelog even for a package built outside Debian; release notes live on GitHub.
# A version with a hyphen (e.g. 0.7.0-rc.1) is a "non-native" package to Debian,
# whose changelog has a different name.
case $version in *-*) changelog=changelog.Debian.gz ;; *) changelog=changelog.gz ;; esac
{
  echo "pipulse ($version) stable; urgency=medium"
  echo
  echo "  * Release $version: https://github.com/seviyon/PiPulse/releases/tag/v$version"
  echo
  echo " -- PiPulse releases <seviyon@users.noreply.github.com>  $(date -R)"
} | gzip -9n > "$root/usr/share/doc/pipulse/$changelog"
mkdir -p "$root/usr/share/lintian/overrides"
install -m 644 "$here/lintian-overrides" "$root/usr/share/lintian/overrides/pipulse"
sed -e "s/@VERSION@/$version/" -e "s/@ARCH@/$arch/" "$here/deb/control.in" > "$root/DEBIAN/control"
echo "Installed-Size: $(du -sk "$root" | cut -f1)" >> "$root/DEBIAN/control"
install -m 644 "$here/deb/conffiles" "$root/DEBIAN/conffiles"
for s in preinst postinst prerm postrm; do install -m 755 "$here/deb/$s" "$root/DEBIAN/$s"; done
mkdir -p "$out"
# xz, not the zstd Ubuntu's dpkg-deb defaults to: dpkg before 1.21.18 (Raspberry Pi OS 11
# "bullseye" and older) can't unpack zstd, and every dpkg reads xz.
dpkg-deb -Zxz --root-owner-group --build "$root" "$out/pipulse_${version}_${arch}.deb" >/dev/null
log "built $out/pipulse_${version}_${arch}.deb"
