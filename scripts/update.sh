#!/usr/bin/env bash
# Bundled self-updater: replaces this install with the latest release for its OS/arch.
# Only the artifact is swapped; durable state in ~/.config/rinnegan is never touched.
set -euo pipefail

REPO="Tanq16/rinnegan"

die() {
  echo "update.sh: error: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required but not found"
command -v tar  >/dev/null 2>&1 || die "tar is required but not found"

os_raw="$(uname -s)"
arch_raw="$(uname -m)"
case "$os_raw" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *) die "unsupported OS: $os_raw (expected Darwin or Linux)" ;;
esac
case "$arch_raw" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64)        ARCH="x64" ;;
  *) die "unsupported architecture: $arch_raw (expected arm64/aarch64 or x86_64)" ;;
esac

BUNDLE_NAME="rinnegan-${OS}-${ARCH}"
ASSET="${BUNDLE_NAME}.tar.gz"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

# Resolve the script's real location, following symlinks, so the install dir is right
# even when update.sh is invoked through a symlink from elsewhere.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE="$(readlink -- "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$DIR/$SOURCE" ;;
  esac
done
INSTALL_DIR="$(cd -P -- "$(dirname -- "$SOURCE")" && pwd)"

# Stage beside the install dir, not in /tmp: the swap below must be a same-filesystem atomic rename, not a cross-device copy.
WORKDIR="$(mktemp -d "$(dirname -- "$INSTALL_DIR")/.rinnegan-update.XXXXXX")"
cleanup() { rm -rf -- "$WORKDIR"; }
trap cleanup EXIT

echo "==> Downloading $ASSET"
curl -fSL -o "$WORKDIR/$ASSET" "$URL" || die "failed to download $URL"

echo "==> Extracting"
tar xzf "$WORKDIR/$ASSET" -C "$WORKDIR" || die "downloaded archive is not a clean tarball"

NEW_DIR="$WORKDIR/$BUNDLE_NAME"
[ -d "$NEW_DIR" ] || die "archive did not contain expected directory $BUNDLE_NAME"
[ -x "$NEW_DIR/bin/rinnegan" ] || die "extracted launcher missing or not executable"

# The gate: prove the download boots before disturbing the current install.
echo "==> Verifying"
"$NEW_DIR/bin/rinnegan" version >/dev/null 2>&1 || die "downloaded build failed its version check; keeping current install"

BACKUP_DIR="${INSTALL_DIR}.bak"
if [ -e "$BACKUP_DIR" ]; then rm -rf -- "$BACKUP_DIR"; fi

echo "==> Installing"
mv -- "$INSTALL_DIR" "$BACKUP_DIR"
if ! mv -- "$NEW_DIR" "$INSTALL_DIR"; then
  mv -- "$BACKUP_DIR" "$INSTALL_DIR"
  die "could not move the new build into place; kept the existing install"
fi

if ! "$INSTALL_DIR/bin/rinnegan" version >/dev/null 2>&1; then
  rm -rf -- "$INSTALL_DIR"
  mv -- "$BACKUP_DIR" "$INSTALL_DIR"
  die "new install failed its boot check; rolled back to the previous version"
fi

rm -rf -- "$BACKUP_DIR"

echo "==> Updated to the latest release in $INSTALL_DIR"
echo "    Restart rinnegan for the update to take effect."
