#!/usr/bin/env bash
# node_modules is copied from the repo at build time, so this is only correct when run on the matching platform (CI runs `npm ci` per target; locally only darwin-arm64).
set -euo pipefail

NODE_VERSION=24.17.0
CADDY_VERSION=2.11.4

die() {
  echo "bundle.sh: error: $*" >&2
  exit 1
}

usage() {
  echo "usage: scripts/bundle.sh <os> <arch>   (os=darwin|linux ; arch=arm64|x64)" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
OS="$1"
ARCH="$2"

case "$OS" in
  darwin|linux) ;;
  *) die "unsupported os '$OS' (expected darwin or linux)" ;;
esac
case "$ARCH" in
  arm64|x64) ;;
  *) die "unsupported arch '$ARCH' (expected arm64 or x64)" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

for req in bin src public node_modules launcher/rinnegan launcher/Caddyfile LICENSE README.md; do
  [ -e "$REPO_ROOT/$req" ] || die "missing required repo path: $req"
done

command -v curl >/dev/null 2>&1 || die "curl is required but not found"
command -v tar  >/dev/null 2>&1 || die "tar is required but not found"

BUNDLE_NAME="rinnegan-${OS}-${ARCH}"
DIST_DIR="$REPO_ROOT/dist"
mkdir -p "$DIST_DIR"

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rinnegan-bundle.XXXXXX")"
cleanup() { rm -rf "$BUILD_ROOT"; }
trap cleanup EXIT

BUNDLE_ROOT="$BUILD_ROOT/$BUNDLE_NAME"

echo "==> Assembling $BUNDLE_NAME in $BUNDLE_ROOT"
mkdir -p "$BUNDLE_ROOT/bin" \
         "$BUNDLE_ROOT/runtime/bin" \
         "$BUNDLE_ROOT/lib/bin" \
         "$BUNDLE_ROOT/lib/src" \
         "$BUNDLE_ROOT/lib/public" \
         "$BUNDLE_ROOT/lib/node_modules"

echo "==> Copying application code"
cp -R "$REPO_ROOT/bin/."          "$BUNDLE_ROOT/lib/bin/"
cp -R "$REPO_ROOT/src/."          "$BUNDLE_ROOT/lib/src/"
cp -R "$REPO_ROOT/public/."       "$BUNDLE_ROOT/lib/public/"
cp -R "$REPO_ROOT/node_modules/." "$BUNDLE_ROOT/lib/node_modules/"

cp "$REPO_ROOT/launcher/rinnegan" "$BUNDLE_ROOT/bin/rinnegan"
chmod 755 "$BUNDLE_ROOT/bin/rinnegan"

cp "$REPO_ROOT/LICENSE"   "$BUNDLE_ROOT/LICENSE"
cp "$REPO_ROOT/README.md" "$BUNDLE_ROOT/README.md"

# darwin dist uses .tar.gz, linux dist uses .tar.xz; `tar xf` autodetects.
if [ "$OS" = "darwin" ]; then
  NODE_EXT="tar.gz"
else
  NODE_EXT="tar.xz"
fi
NODE_PKG="node-v${NODE_VERSION}-${OS}-${ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.${NODE_EXT}"
NODE_TARBALL="$BUILD_ROOT/${NODE_PKG}.${NODE_EXT}"

echo "==> Downloading Node runtime: $NODE_URL"
curl -fL -o "$NODE_TARBALL" "$NODE_URL" || die "failed to download Node runtime from $NODE_URL"

echo "==> Extracting Node runtime"
NODE_EXTRACT_DIR="$BUILD_ROOT/node-extract"
mkdir -p "$NODE_EXTRACT_DIR"
tar xf "$NODE_TARBALL" -C "$NODE_EXTRACT_DIR"

NODE_BIN_SRC="$NODE_EXTRACT_DIR/$NODE_PKG/bin/node"
[ -x "$NODE_BIN_SRC" ] || [ -f "$NODE_BIN_SRC" ] || die "node binary not found at $NODE_BIN_SRC after extraction"
cp "$NODE_BIN_SRC" "$BUNDLE_ROOT/runtime/bin/node"
chmod 755 "$BUNDLE_ROOT/runtime/bin/node"

# Caddy's release naming differs from ours: darwin->mac, x64->amd64.
case "$OS" in
  darwin) CADDY_OS="mac" ;;
  linux)  CADDY_OS="linux" ;;
esac
case "$ARCH" in
  x64)   CADDY_ARCH="amd64" ;;
  arm64) CADDY_ARCH="arm64" ;;
esac
CADDY_PKG="caddy_${CADDY_VERSION}_${CADDY_OS}_${CADDY_ARCH}"
CADDY_URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${CADDY_PKG}.tar.gz"
CADDY_TARBALL="$BUILD_ROOT/${CADDY_PKG}.tar.gz"

echo "==> Downloading Caddy: $CADDY_URL"
curl -fL -o "$CADDY_TARBALL" "$CADDY_URL" || die "failed to download Caddy from $CADDY_URL"

echo "==> Extracting Caddy"
CADDY_EXTRACT_DIR="$BUILD_ROOT/caddy-extract"
mkdir -p "$CADDY_EXTRACT_DIR"
tar xf "$CADDY_TARBALL" -C "$CADDY_EXTRACT_DIR"

CADDY_BIN_SRC="$CADDY_EXTRACT_DIR/caddy"
[ -f "$CADDY_BIN_SRC" ] || die "caddy binary not found at $CADDY_BIN_SRC after extraction"
cp "$CADDY_BIN_SRC" "$BUNDLE_ROOT/bin/caddy"
chmod 755 "$BUNDLE_ROOT/bin/caddy"

cp "$REPO_ROOT/launcher/Caddyfile" "$BUNDLE_ROOT/Caddyfile"

# Copy licenses unconditionally so set -e aborts on a missing one rather than silently shipping a bundle without a promised license.
mkdir -p "$BUNDLE_ROOT/licenses"
cp "$CADDY_EXTRACT_DIR/LICENSE" "$BUNDLE_ROOT/licenses/caddy-LICENSE"
cp "$NODE_EXTRACT_DIR/$NODE_PKG/LICENSE" "$BUNDLE_ROOT/licenses/node-LICENSE"

TARBALL="$DIST_DIR/${BUNDLE_NAME}.tar.gz"
echo "==> Creating tarball $TARBALL"
rm -f "$TARBALL"
# -C into BUILD_ROOT so the archive's top-level dir is exactly BUNDLE_NAME.
tar czf "$TARBALL" -C "$BUILD_ROOT" "$BUNDLE_NAME"

if SIZE="$(du -h "$TARBALL" 2>/dev/null | cut -f1)"; then
  SIZE="$(echo "$SIZE" | tr -d '[:space:]')"
else
  SIZE="unknown"
fi

echo ""
echo "==> Done."
echo "    tarball: $TARBALL"
echo "    size:    $SIZE"
