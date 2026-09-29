# Shared helpers for PiPulse's packaging scripts. POSIX sh; source it.
log() { printf '[pipulse] %s\n' "$*"; }
die() { printf '[pipulse] error: %s\n' "$*" >&2; exit 1; }

# The CPU as Debian names it: userland, not kernel (a Pi 4 on 32-bit Pi OS is armhf).
pipulse_arch() {
  # Raspbian's armhf is built for armv6, so dpkg says armhf on a Pi 1 or Zero too:
  # ask the CPU itself first.
  [ "$(uname -m)" != armv6l ] || die "this Pi (armv6) is not supported: Node 22 has no official build for it"
  arch=${PIPULSE_ARCH:-}
  if [ -z "$arch" ]; then
    if command -v dpkg >/dev/null 2>&1; then arch=$(dpkg --print-architecture)
    else case $(uname -m) in armv7l) arch=armhf ;; aarch64) arch=arm64 ;; x86_64) arch=amd64 ;; *) arch=$(uname -m) ;; esac
    fi
  fi
  case $arch in
    armhf | arm64 | amd64) printf '%s\n' "$arch" ;;
    armel | armv6l) die "this Pi (armv6) is not supported: Node 22 has no official build for it" ;;
    *) die "unsupported CPU: $arch" ;;
  esac
}

# env_value NAME [FILE] — a setting from pipulse.env as systemd reads it: the last
# NAME= line, with surrounding quotes removed.
env_value() {
  sed -n "s/^$1=//p" "${2:-/etc/pipulse/pipulse.env}" 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# node_version ARCH — the pinned Node version for that CPU.
node_version() {
  sed -n "s/.*\"$1\": *\"\([0-9.]*\)\".*/\1/p" "${PIPULSE_NODE_VERSIONS:-$(dirname "$0")/node-versions.json}"
}

# node_dist ARCH — Node's name for that CPU in its download file names.
node_dist() { case $1 in armhf) echo armv7l ;; arm64) echo arm64 ;; amd64) echo x64 ;; esac; }
