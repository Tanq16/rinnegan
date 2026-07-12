#!/usr/bin/env bash
#
# bundle.sh - assemble one fully self-contained rinnegan release tarball.
#
# Usage: scripts/bundle.sh <os> <arch>
#   os   = darwin | linux
#   arch = arm64  | x64
#
# Produces: dist/rinnegan-<os>-<arch>.tar.gz  (top dir rinnegan-<os>-<arch>/)
#
# The tarball bundles its OWN Node 24.17.0 runtime plus a platform-native
# node_modules (incl. node-pty), so the end user needs no Node/compiler/etc.
#
# IMPORTANT: node_modules is copied from what is installed in the repo at
# build time. It is only correct when this script runs ON the matching
# platform (CI runs `npm ci` on a native runner per target). Locally this
# script is valid only for the host platform (darwin-arm64).
set -euo pipefail

NODE_VERSION=24.17.0

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

# Resolve repo root: this script lives in <repo>/scripts/.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Sanity-check that the repo pieces we copy actually exist.
for req in bin src public node_modules launcher/rinnegan LICENSE README.md scripts/seed.mjs; do
  [ -e "$REPO_ROOT/$req" ] || die "missing required repo path: $req"
done

command -v curl >/dev/null 2>&1 || die "curl is required but not found"
command -v tar  >/dev/null 2>&1 || die "tar is required but not found"

# We use whatever `node` is on PATH (CI provides 24.17.0) to run the seed script.
command -v node >/dev/null 2>&1 || die "node is required on PATH to run the seed script"

BUNDLE_NAME="rinnegan-${OS}-${ARCH}"
DIST_DIR="$REPO_ROOT/dist"
mkdir -p "$DIST_DIR"

# Build in an isolated temp dir; clean it up on any exit.
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

# Copy application code verbatim into lib/.
echo "==> Copying application code"
cp -R "$REPO_ROOT/bin/."          "$BUNDLE_ROOT/lib/bin/"
cp -R "$REPO_ROOT/src/."          "$BUNDLE_ROOT/lib/src/"
cp -R "$REPO_ROOT/public/."       "$BUNDLE_ROOT/lib/public/"
cp -R "$REPO_ROOT/node_modules/." "$BUNDLE_ROOT/lib/node_modules/"

# Launcher -> bin/rinnegan (executable).
cp "$REPO_ROOT/launcher/rinnegan" "$BUNDLE_ROOT/bin/rinnegan"
chmod 755 "$BUNDLE_ROOT/bin/rinnegan"

# License + readme at bundle root.
cp "$REPO_ROOT/LICENSE"   "$BUNDLE_ROOT/LICENSE"
cp "$REPO_ROOT/README.md" "$BUNDLE_ROOT/README.md"

# --- Download + extract the official Node runtime for this os/arch. ---
# darwin dist uses .tar.gz ; linux dist uses .tar.xz. `tar xf` autodetects.
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

# --- Seed config.json + users.json into the bundle root. ---
echo "==> Seeding config.json + users.json"
node "$REPO_ROOT/scripts/seed.mjs" "$BUNDLE_ROOT"

# --- Package the tarball. ---
TARBALL="$DIST_DIR/${BUNDLE_NAME}.tar.gz"
echo "==> Creating tarball $TARBALL"
rm -f "$TARBALL"
# -C into BUILD_ROOT so the archive's top-level dir is exactly BUNDLE_NAME.
tar czf "$TARBALL" -C "$BUILD_ROOT" "$BUNDLE_NAME"

# --- Report final path + human-readable size. ---
if SIZE="$(du -h "$TARBALL" 2>/dev/null | cut -f1)"; then
  SIZE="$(echo "$SIZE" | tr -d '[:space:]')"
else
  SIZE="unknown"
fi

echo ""
echo "==> Done."
echo "    tarball: $TARBALL"
echo "    size:    $SIZE"
