import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDir, atomicWriteFileSync, resolveShell } from './config.js';
import { parseCookies, verifySession, signSession, serializeCookie } from './auth.js';
import { loadRecord, verify, fingerprint } from './password.js';
import { createHttpServer } from './http.js';
import { attachWebSocket } from './ws.js';
import { attachTunnel } from './tunnel.js';
import { attachProxy, splitProxyPath } from './proxy.js';
import { createAliasStore } from './proxies.js';
import { info, error } from './log.js';

function startCaddy(root, flags) {
  const caddyBin = flags['caddy-bin'] ? path.resolve(flags['caddy-bin'])
    : root ? path.join(root, 'bin', 'caddy') : null;
  const dataDir = flags['caddy-data'] ? path.resolve(flags['caddy-data'])
    : path.join(configDir(), 'caddy-data');
  if (!caddyBin || !existsSync(caddyBin)) {
    throw new Error(
      `--https requires the bundled Caddy binary; not found at ${caddyBin ?? '<unknown>'}. ` +
      `Run rinnegan from a release bundle, or pass --caddy-bin <path> --caddyfile <path>.`
    );
  }
  const caddyfile = resolveCaddyfile(root, flags);
  const proc = spawn(caddyBin, ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {
    stdio: 'inherit',
    env: { ...process.env, XDG_DATA_HOME: dataDir, XDG_CONFIG_HOME: dataDir },
  });
  return { proc, caddyfile };
}

// Runtime Caddyfile lives under configDir() so it survives the updater wiping the release dir.
export function resolveCaddyfile(root, flags) {
  if (flags['caddyfile']) {
    const explicit = path.resolve(flags['caddyfile']);
    if (!existsSync(explicit)) throw new Error(`--https requires a Caddyfile; not found at ${explicit}.`);
    return explicit;
  }
  const runtime = path.join(configDir(), 'Caddyfile');
  const template = root ? path.join(root, 'Caddyfile') : null;
  const refresh = flags['refresh-caddyfile'] === true;
  const haveRuntime = existsSync(runtime);
  if (refresh || !haveRuntime) {
    if (!template || !existsSync(template)) {
      if (!haveRuntime) throw new Error(`--https requires a Caddyfile; not found at ${template ?? '<unknown>'}.`);
    } else {
      if (refresh && haveRuntime) process.stderr.write(`warning: --refresh-caddyfile overwrites ${runtime}; local edits are discarded\n`);
      atomicWriteFileSync(runtime, readFileSync(template), 0o600);
    }
  }
  return runtime;
}

// os.userInfo() throws when the running uid has no passwd entry, which is common in containers.
function osUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || 'unknown';
  }
}

export function start(cfg, flags = {}) {
  const https = flags.https === true;
  if (https) cfg.cookie.secure = true;
  if (https && cfg.listen.port !== 8442) process.stderr.write(`warning: --https bundled Caddyfile proxies to 127.0.0.1:8442 but listen.port is ${cfg.listen.port}; edit the Caddyfile to match\n`);

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
    ? () => ({ accessExp: null })
    : (req) => {
        const payload = verifySession(parseCookies(req.headers.cookie)[cfg.cookie.name], secret, 'access');
        return payload ? { fp: payload.fp, accessExp: payload.exp } : null;
      };

  const publicDir = fileURLToPath(new URL('../public', import.meta.url));

  const host = {
    hostname: os.hostname(),
    platform: process.platform,
    user: osUser(),
    shell: cfg.terminal.shell,
  };

  const terminal = attachWebSocket({ config: cfg, authenticate, authOn, host, currentFingerprint });

  const aliases = cfg.proxy.enabled ? createAliasStore(path.join(configDir(), 'proxies.json')) : null;
  const proxy = aliases
    ? attachProxy({ aliases: aliases.entries, cookieNames: [cfg.cookie.name, refreshCookieName], secure: cfg.cookie.secure })
    : null;

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
          signSession({ fp, typ: 'access' }, secret, cfg.cookie.accessTtlSeconds),
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
    makeSessionCookie: (fp) => [
      serializeCookie(
        cfg.cookie.name,
        signSession({ fp, typ: 'access' }, secret, cfg.cookie.accessTtlSeconds),
        { maxAge: cfg.cookie.accessTtlSeconds, secure: cfg.cookie.secure }
      ),
      serializeCookie(
        refreshCookieName,
        signSession({ fp, typ: 'refresh' }, secret, cfg.cookie.refreshTtlSeconds),
        { maxAge: cfg.cookie.refreshTtlSeconds, secure: cfg.cookie.secure, path: '/refresh' }
      ),
    ],
    clearSessionCookie: () => [
      serializeCookie(cfg.cookie.name, '', { maxAge: 0, secure: cfg.cookie.secure }),
      serializeCookie(refreshCookieName, '', { maxAge: 0, secure: cfg.cookie.secure, path: '/refresh' }),
    ],
    refresh,
    publicDir,
    proxy,
    aliases,
  });
  const tunnel = attachTunnel({ authenticate });
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { ({ pathname } = new URL(req.url, 'http://x')); } catch { socket.destroy(); return; }
    if (pathname === '/ws') { terminal.handleUpgrade(req, socket, head); return; }
    if (pathname === '/tunnel') { tunnel.handleUpgrade(req, socket, head); return; }
    if (proxy && pathname.startsWith('/proxy/')) {
      const session = authenticate(req);
      const split = session && splitProxyPath(req.url);
      if (!split) { socket.destroy(); return; }
      proxy.handleUpgrade(req, socket, head, split, session);
      return;
    }
    socket.destroy();
  });

  // hoisted so an abnormal server exit tears Caddy down instead of orphaning the public listener
  let caddy;
  server.on('error', (e) => {
    error(`server error: ${e.message}`);
    try { caddy?.kill('SIGTERM'); } catch {}
    process.exit(1);
  });

  const shutdown = () => { try { caddy?.kill('SIGTERM'); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(cfg.listen.port, cfg.listen.host, () => {
    info(`rinnegan listening on http://${cfg.listen.host}:${server.address().port}`);
    if (https) {
      let started;
      try { started = startCaddy(process.env.RINNEGAN_ROOT || null, flags); }
      catch (e) { error(e.message); process.exit(1); }
      caddy = started.proc;
      // Naming the file rather than an address: the listeners and issuer are the Caddyfile's to define, and Caddy logs them itself.
      info(`rinnegan HTTPS front (Caddy) starting with ${started.caddyfile}`);
      caddy.on('exit', (code, sig) => { error(`caddy exited (code=${code} signal=${sig}); shutting down`); process.exit(code == null ? 1 : code); });
      caddy.on('error', (e) => { error(`failed to start caddy: ${e.message}`); process.exit(1); });
    }
  });
}
