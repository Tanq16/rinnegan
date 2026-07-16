#!/usr/bin/env bash
# Proves a built tarball is self-contained: extract it, scrub node from PATH, and confirm
# both the plain-HTTP server and the bundled-Caddy HTTPS front serve with only the bundled runtime.
set -euo pipefail

die() {
  echo "smoke-test.sh: error: $*" >&2
  exit 1
}

usage() {
  echo "usage: scripts/smoke-test.sh <os> <arch>   (os=darwin|linux ; arch=arm64|x64)" >&2
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

BUNDLE_NAME="rinnegan-${OS}-${ARCH}"
TARBALL="$REPO_ROOT/dist/${BUNDLE_NAME}.tar.gz"
[ -f "$TARBALL" ] || die "tarball not found: $TARBALL"

SMOKE_DIR="$(mktemp -d)"
tar xzf "$TARBALL" -C "$SMOKE_DIR"
APP_DIR="$SMOKE_DIR/$BUNDLE_NAME"
[ -x "$APP_DIR/bin/rinnegan" ] || die "launcher missing/not executable"
[ -x "$APP_DIR/runtime/bin/node" ] || die "bundled node missing/not executable"

cd "$APP_DIR"

SERVER_PID=""
HTTPS_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
  [ -n "$HTTPS_PID" ] && { kill "$HTTPS_PID" 2>/dev/null || true; wait "$HTTPS_PID" 2>/dev/null || true; }
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

# Scrubbed PATH deliberately excludes node so startup proves the bundled runtime is used.
env -i HOME="$HOME" PATH=/usr/bin:/bin TERM=xterm-256color \
  ./bin/rinnegan serve --config ./config.json > server.log 2>&1 &
SERVER_PID=$!

# Confirm node is not on the scrubbed PATH, else the test cannot prove self-containment.
if env -i PATH=/usr/bin:/bin command -v node >/dev/null 2>&1; then
  die "node found on scrubbed PATH; smoke test cannot prove self-containment"
fi

LOGIN_CODE=""
for _ in $(seq 1 30); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited early; log:"; cat server.log || true; exit 1
  fi
  LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8442/login || true)"
  [ "$LOGIN_CODE" = "200" ] && break
  sleep 1
done
[ "$LOGIN_CODE" = "200" ] || { echo "GET /login expected 200 but got '$LOGIN_CODE'; log:"; cat server.log || true; exit 1; }
echo "GET /login -> 200 OK"

ROOT_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8442/ || true)"
[ "$ROOT_CODE" = "302" ] || { echo "GET / expected 302 but got '$ROOT_CODE'; log:"; cat server.log || true; exit 1; }
echo "GET / -> 302 OK"

# The --https server also binds 8442, so stop the HTTP-only server first to free the port.
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# Caddy is invoked by absolute path via RINNEGAN_ROOT, so the scrubbed PATH does not affect it.
env -i HOME="$HOME" PATH=/usr/bin:/bin TERM=xterm-256color \
  ./bin/rinnegan serve --https --config ./config.json > https.log 2>&1 &
HTTPS_PID=$!

# -k accepts the self-signed cert.
HTTPS_LOGIN_CODE=""
for _ in $(seq 1 30); do
  if ! kill -0 "$HTTPS_PID" 2>/dev/null; then
    echo "https server exited early; log:"; cat https.log || true; exit 1
  fi
  HTTPS_LOGIN_CODE="$(curl -k -s -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/login || true)"
  [ "$HTTPS_LOGIN_CODE" = "200" ] && break
  sleep 1
done
[ "$HTTPS_LOGIN_CODE" = "200" ] || { echo "HTTPS GET /login expected 200 but got '$HTTPS_LOGIN_CODE'; log:"; cat https.log || true; exit 1; }

HTTPS_ROOT_CODE="$(curl -k -s -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/ || true)"
[ "$HTTPS_ROOT_CODE" = "302" ] || { echo "HTTPS GET / expected 302 but got '$HTTPS_ROOT_CODE'; log:"; cat https.log || true; exit 1; }
echo "HTTPS via bundled Caddy -> 200/302 OK"

echo "Smoke test passed for $BUNDLE_NAME"
