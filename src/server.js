import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveShell } from './config.js';
import { parseCookies, verifySession, signSession, serializeCookie } from './auth.js';
import { loadRecord, verify, fingerprint } from './password.js';
import { createHttpServer } from './http.js';
import { attachWebSocket } from './ws.js';
import { attachTunnel } from './tunnel.js';
import { info, error } from './log.js';

// os.userInfo() throws when the running uid has no passwd entry, which is common in containers.
function osUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || 'unknown';
  }
}

export function start(cfg, flags = {}) {
  // !== undefined, not truthiness: `--shell ""` must fail the allowlist, not fall through to the config default.
  if (flags.shell !== undefined) cfg.terminal.shell = resolveShell(flags.shell);

  const noAuth = flags['no-auth'] === true;
  const authOn = !noAuth;
  if (noAuth) process.stderr.write('warning: --no-auth disables authentication; anyone who reaches the port gets a host shell\n');
  if (authOn && !existsSync(cfg.authFile)) {
    error('no password configured; set one with `rinnegan passwd` or start with --no-auth to disable authentication');
    process.exit(1);
  }

  // per-boot signing secret: sessions do not survive restarts
  const secret = randomBytes(32).toString('base64');
  // Replaces the old roster re-check: a password change moves this, so every session minted before it stops refreshing.
  const currentFingerprint = noAuth ? () => null : () => fingerprint(loadRecord(cfg.authFile), secret);

  const refreshCookieName = cfg.cookie.name + '_rt';

  const authenticate = noAuth
    ? () => ({ accessExp: null, sessionExp: null })
    : (req) => {
        const payload = verifySession(parseCookies(req.headers.cookie)[cfg.cookie.name], secret, 'access');
        if (!payload) return null;
        return { fp: payload.fp, accessExp: payload.exp, sessionExp: typeof payload.sxp === 'number' ? payload.sxp : payload.exp };
      };

  const publicDir = fileURLToPath(new URL('../public', import.meta.url));

  const host = {
    hostname: os.hostname(),
    platform: process.platform,
    user: osUser(),
    shell: cfg.terminal.shell,
  };

  const terminal = attachWebSocket({ config: cfg, authenticate, authOn, host, currentFingerprint });

  const refresh = noAuth
    ? () => ({ accessExpiresAt: null })
    : (req) => {
        const token = parseCookies(req.headers.cookie)[refreshCookieName];
        const payload = verifySession(token, secret, 'refresh');
        if (!payload) return null;
        const fp = currentFingerprint();
        if (fp !== payload.fp) return null;
        const now = Math.floor(Date.now() / 1000);
        const exp = now + cfg.cookie.accessTtlSeconds;
        const setCookie = serializeCookie(
          cfg.cookie.name,
          signSession({ fp, typ: 'access', sxp: payload.exp }, secret, cfg.cookie.accessTtlSeconds),
          { maxAge: cfg.cookie.accessTtlSeconds, secure: cfg.cookie.secure }
        );
        terminal.touchAll(fp, exp);
        return { setCookie, accessExpiresAt: exp };
      };

  const server = createHttpServer({
    authenticate,
    authOn,
    login: async (password) => {
      const record = await verify(cfg.authFile, password);
      return record ? fingerprint(record, secret) : null;
    },
    // Access cookie MUST be first: the CLI tunnel client extracts the first Set-Cookie pair.
    makeSessionCookie: (fp) => {
      const sxp = Math.floor(Date.now() / 1000) + cfg.cookie.refreshTtlSeconds;
      return [
        serializeCookie(
          cfg.cookie.name,
          signSession({ fp, typ: 'access', sxp }, secret, cfg.cookie.accessTtlSeconds),
          { maxAge: cfg.cookie.accessTtlSeconds, secure: cfg.cookie.secure }
        ),
        serializeCookie(
          refreshCookieName,
          signSession({ fp, typ: 'refresh' }, secret, cfg.cookie.refreshTtlSeconds),
          { maxAge: cfg.cookie.refreshTtlSeconds, secure: cfg.cookie.secure, path: '/refresh' }
        ),
      ];
    },
    clearSessionCookie: () => [
      serializeCookie(cfg.cookie.name, '', { maxAge: 0, secure: cfg.cookie.secure }),
      serializeCookie(refreshCookieName, '', { maxAge: 0, secure: cfg.cookie.secure, path: '/refresh' }),
    ],
    refresh,
    publicDir,
  });
  const tunnel = attachTunnel({ authenticate });
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { ({ pathname } = new URL(req.url, 'http://x')); } catch { socket.destroy(); return; }
    if (pathname === '/ws') { terminal.handleUpgrade(req, socket, head); return; }
    if (pathname === '/tunnel') { tunnel.handleUpgrade(req, socket, head); return; }
    socket.destroy();
  });

  server.on('error', (e) => {
    error(`server error: ${e.message}`);
    process.exit(1);
  });

  const shutdown = () => process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(cfg.listen.port, cfg.listen.host, () => {
    info(`rinnegan listening on http://${cfg.listen.host}:${server.address().port}`);
  });
}
