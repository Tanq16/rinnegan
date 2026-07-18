#!/usr/bin/env bash
# Proves a built tarball is self-contained: extract it, scrub node from PATH, and confirm node-pty
# spawns and both the plain-HTTP server and the bundled-Caddy HTTPS front serve on the bundled runtime.
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
[ -x "$APP_DIR/update.sh" ] || die "update.sh missing or not executable"

cd "$APP_DIR"

# serve now self-seeds config/state into ~/.config/rinnegan; sandbox HOME so it lands in the temp dir, never the real home.
SMOKE_HOME="$SMOKE_DIR/home"
mkdir -p "$SMOKE_HOME"

# The updater's verify gate is `rinnegan version`; exercise it so a tarball that would brick self-update can't ship undetected.
env -i HOME="$SMOKE_HOME" PATH=/usr/bin:/bin "$APP_DIR/bin/rinnegan" version >/dev/null || die "rinnegan version failed; updater verify gate would fail"

SERVER_PID=""
HTTPS_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
  [ -n "$HTTPS_PID" ] && { kill "$HTTPS_PID" 2>/dev/null || true; wait "$HTTPS_PID" 2>/dev/null || true; }
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

# node-pty's darwin prebuild fails at spawn() time, not import time, so only a real spawn catches it.
# cd lib so the bare specifier resolves the bundle's node_modules, not the repo's.
if ! ( cd lib && env -i HOME="$SMOKE_HOME" PATH=/usr/bin:/bin TERM=xterm-256color \
  ../runtime/bin/node --input-type=module -e "
import pty from 'node-pty';
const bail = setTimeout(() => process.exit(1), 10000);
const t = pty.spawn('/usr/bin/env', ['sh', '-c', 'echo pty-ok'], { name: 'xterm-256color', cols: 120, rows: 36, env: process.env });
let out = '';
t.onData((d) => { out += d; });
t.onExit((e) => { clearTimeout(bail); process.exit(out.includes('pty-ok') && e.exitCode === 0 ? 0 : 1); });
" ); then
  die "node-pty failed to spawn a PTY with the bundled runtime"
fi
echo "node-pty spawns a real PTY -> OK"

# --no-auth boots headlessly with no seeded user; the scrubbed PATH proves the bundled runtime is used.
env -i HOME="$SMOKE_HOME" PATH=/usr/bin:/bin TERM=xterm-256color \
  ./bin/rinnegan serve --no-auth > server.log 2>&1 &
SERVER_PID=$!

# Confirm node is not on the scrubbed PATH, else the test cannot prove self-containment.
if env -i PATH=/usr/bin:/bin command -v node >/dev/null 2>&1; then
  die "node found on scrubbed PATH; smoke test cannot prove self-containment"
fi

ROOT_CODE=""
for _ in $(seq 1 30); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited early; log:"; cat server.log || true; exit 1
  fi
  ROOT_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8442/ || true)"
  [ "$ROOT_CODE" = "200" ] && break
  sleep 1
done
[ "$ROOT_CODE" = "200" ] || { echo "GET / expected 200 but got '$ROOT_CODE'; log:"; cat server.log || true; exit 1; }
echo "GET / -> 200 OK (--no-auth)"

# The synthetic session is always present under --no-auth, so /login redirects to /.
LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8442/login || true)"
[ "$LOGIN_CODE" = "302" ] || { echo "GET /login expected 302 but got '$LOGIN_CODE'; log:"; cat server.log || true; exit 1; }
echo "GET /login -> 302 OK (--no-auth)"

# The --https server also binds 8442, so stop the HTTP-only server first to free the port.
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# Caddy is invoked by absolute path via RINNEGAN_ROOT, so the scrubbed PATH does not affect it.
env -i HOME="$SMOKE_HOME" PATH=/usr/bin:/bin TERM=xterm-256color \
  ./bin/rinnegan serve --https --no-auth > https.log 2>&1 &
HTTPS_PID=$!

# -k accepts the self-signed cert.
HTTPS_ROOT_CODE=""
for _ in $(seq 1 30); do
  if ! kill -0 "$HTTPS_PID" 2>/dev/null; then
    echo "https server exited early; log:"; cat https.log || true; exit 1
  fi
  HTTPS_ROOT_CODE="$(curl -k -s -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/ || true)"
  [ "$HTTPS_ROOT_CODE" = "200" ] && break
  sleep 1
done
[ "$HTTPS_ROOT_CODE" = "200" ] || { echo "HTTPS GET / expected 200 but got '$HTTPS_ROOT_CODE'; log:"; cat https.log || true; exit 1; }

HTTPS_LOGIN_CODE="$(curl -k -s -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/login || true)"
[ "$HTTPS_LOGIN_CODE" = "302" ] || { echo "HTTPS GET /login expected 302 but got '$HTTPS_LOGIN_CODE'; log:"; cat https.log || true; exit 1; }
echo "HTTPS via bundled Caddy -> 200/302 OK"

echo "Smoke test passed for $BUNDLE_NAME"
