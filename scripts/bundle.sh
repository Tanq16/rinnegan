#!/usr/bin/env bash
# node_modules is copied from the repo at build time, so this is only correct when run on the matching platform (CI runs `npm ci` per target; locally only darwin-arm64).
set -euo pipefail

NODE_VERSION=24.17.0
CADDY_VERSION=2.11.4
XCADDY_VERSION=v0.4.5

# Pinned by tag, not floating: an upstream regression cannot reach a release until this list is bumped.
CADDY_DNS_MODULES="
github.com/caddy-dns/cloudflare@v0.2.4
github.com/caddy-dns/porkbun@v0.3.1
github.com/caddy-dns/namecheap@v1.0.0
github.com/caddy-dns/godaddy@v1.2.0
github.com/caddy-dns/duckdns@v0.5.0
github.com/caddy-dns/acmedns@v0.7.0
"

# stock is the escape hatch for a machine with no Go toolchain or a wedged module; it cannot run the DNS-01 samples.
CADDY_BUILD="${CADDY_BUILD:-xcaddy}"

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

for req in bin src public node_modules launcher/rinnegan launcher/Caddyfile launcher/Caddyfile.domain.example launcher/Caddyfile.wildcard.example LICENSE README.md package.json scripts/update.sh; do
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

# `rinnegan version` reads this at runtime (the updater's verify gate), so it must ship in lib/.
cp "$REPO_ROOT/package.json" "$BUNDLE_ROOT/lib/package.json"

cp "$REPO_ROOT/launcher/rinnegan" "$BUNDLE_ROOT/bin/rinnegan"
chmod 755 "$BUNDLE_ROOT/bin/rinnegan"

cp "$REPO_ROOT/scripts/update.sh" "$BUNDLE_ROOT/update.sh"
chmod 755 "$BUNDLE_ROOT/update.sh"

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

case "$CADDY_BUILD" in
  xcaddy)
    command -v go >/dev/null 2>&1 || die "CADDY_BUILD=xcaddy needs the Go toolchain; install Go, or re-run with CADDY_BUILD=stock"
    case "$ARCH" in
      x64)   GO_ARCH="amd64" ;;
      arm64) GO_ARCH="arm64" ;;
    esac
    XCADDY_ARGS=()
    for mod in $CADDY_DNS_MODULES; do XCADDY_ARGS+=(--with "$mod"); done

    echo "==> Building Caddy $CADDY_VERSION with DNS modules (xcaddy $XCADDY_VERSION)"
    # Build natively: Go does not ad-hoc sign a darwin/arm64 binary cross-compiled from another host, and the kernel then refuses to exec it.
    CADDY_BIN_SRC="$BUILD_ROOT/caddy"
    ( cd "$BUILD_ROOT" && GOOS="$OS" GOARCH="$GO_ARCH" \
      go run "github.com/caddyserver/xcaddy/cmd/xcaddy@$XCADDY_VERSION" \
        build "v$CADDY_VERSION" --output "$CADDY_BIN_SRC" "${XCADDY_ARGS[@]}" ) \
      || die "xcaddy build failed"

    CADDY_LICENSE_SRC="$BUILD_ROOT/caddy-LICENSE"
    curl -fL -o "$CADDY_LICENSE_SRC" "https://raw.githubusercontent.com/caddyserver/caddy/v${CADDY_VERSION}/LICENSE" \
      || die "failed to download the Caddy LICENSE for v${CADDY_VERSION}"
    ;;
  stock)
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
    CADDY_LICENSE_SRC="$CADDY_EXTRACT_DIR/LICENSE"
    ;;
  *)
    die "unknown CADDY_BUILD '$CADDY_BUILD' (expected xcaddy or stock)"
    ;;
esac

[ -f "$CADDY_BIN_SRC" ] || die "caddy binary not found at $CADDY_BIN_SRC"
cp "$CADDY_BIN_SRC" "$BUNDLE_ROOT/bin/caddy"
chmod 755 "$BUNDLE_ROOT/bin/caddy"

cp "$REPO_ROOT/launcher/Caddyfile" "$BUNDLE_ROOT/Caddyfile"
# Samples only: resolveCaddyfile never seeds these, so a real-domain setup points --caddyfile at one.
cp "$REPO_ROOT/launcher/Caddyfile.domain.example"   "$BUNDLE_ROOT/Caddyfile.domain.example"
cp "$REPO_ROOT/launcher/Caddyfile.wildcard.example" "$BUNDLE_ROOT/Caddyfile.wildcard.example"

# Copy licenses unconditionally so set -e aborts on a missing one rather than silently shipping a bundle without a promised license.
mkdir -p "$BUNDLE_ROOT/licenses"
cp "$CADDY_LICENSE_SRC" "$BUNDLE_ROOT/licenses/caddy-LICENSE"
cp "$NODE_EXTRACT_DIR/$NODE_PKG/LICENSE" "$BUNDLE_ROOT/licenses/node-LICENSE"

# The Apache-2.0 above covers Caddy itself, not the third-party modules linked into the same binary.
if [ "$CADDY_BUILD" = "xcaddy" ]; then
  {
    echo "bin/caddy is Caddy v${CADDY_VERSION} (Apache-2.0, see caddy-LICENSE), built with xcaddy ${XCADDY_VERSION}"
    echo "and the following third-party DNS provider modules. Each carries its own license at its source:"
    echo ""
    for mod in $CADDY_DNS_MODULES; do echo "  https://${mod%@*}  ${mod#*@}"; done
  } > "$BUNDLE_ROOT/licenses/caddy-dns-modules.txt"
fi

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
echo "    caddy:   $CADDY_BUILD"
