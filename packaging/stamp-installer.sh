#!/bin/sh
# stamp-installer.sh IN OUT — copies install.sh with the apt signing key (packaging/apt-key.gpg, the
# public half) written into it. The installer trusts only that key: it does not fetch one from the
# apt site, which could swap the key and the packages together. A copy that was not stamped
# (a source checkout) has no key and refuses to install from apt.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
[ "$#" -eq 2 ] || { echo 'usage: stamp-installer.sh IN OUT' >&2; exit 1; }
key=$(base64 < "$here/apt-key.gpg" | tr -d '\n')
[ -n "$key" ] || { echo 'packaging/apt-key.gpg is empty' >&2; exit 1; }
grep -q '^APT_KEY_B64=.@@PIPULSE_APT_KEY@@.$' "$1" || { echo "$1 has no @@PIPULSE_APT_KEY@@ placeholder" >&2; exit 1; }
sed "s|^APT_KEY_B64=.@@PIPULSE_APT_KEY@@.\$|APT_KEY_B64='$key'|" "$1" > "$2"
grep -q "^APT_KEY_B64='$key'\$" "$2" || { echo 'the key was not written' >&2; exit 1; }
chmod 755 "$2"
