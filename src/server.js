import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, configDir, atomicWriteFileSync } from './config.js';
import { parseCookies, verifySession, signSession, serializeCookie } from './auth.js';
import { verifyLogin, listUsers } from './users.js';
import { createPtySession } from './pty.js';
import { createControl } from './control.js';
import { createHttpServer } from './http.js';
import { attachWebSocket } from './ws.js';
import { attachTunnel } from './tunnel.js';
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
  return spawn(caddyBin, ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {
    stdio: 'inherit',
    env: { ...process.env, XDG_DATA_HOME: dataDir, XDG_CONFIG_HOME: dataDir },
  });
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

export function start(cfg, flags = {}) {
  const https = flags.https === true;
  if (https) cfg.cookie.secure = true;
  if (https && cfg.listen.port !== 8442) process.stderr.write(`warning: --https bundled Caddyfile proxies to 127.0.0.1:8442 but listen.port is ${cfg.listen.port}; edit the Caddyfile to match\n`);

  const noAuth = flags['no-auth'] === true;
  const authOn = !noAuth;
  if (noAuth) process.stderr.write('warning: --no-auth disables authentication; anyone who reaches the port gets a host shell\n');
  const userCount = authOn ? (existsSync(cfg.usersFile) ? listUsers(cfg.usersFile).length : 0) : 0;
  if (authOn && userCount === 0) {
    error('no users configured; create one with `rinnegan user add --username <name>` or start with --no-auth to disable authentication');
    process.exit(1);
  }
  // A shared session needs at least two accounts to meet in it; a solo or no-auth box is terminal-only.
  const offerShared = authOn && userCount > 1;

  const state = loadState(cfg.stateFile);
  // per-boot signing secret: sessions do not survive restarts (spec persists only mode)
  const secret = randomBytes(32).toString('base64');
  const persisted = state.mode;
  const initialMode = (persisted === 'soft' || persisted === 'fast') ? persisted : cfg.control.mode;

  const control = createControl({
    mode: initialMode,
    staleControllerSeconds: cfg.control.staleControllerSeconds,
    requestTimeoutSeconds: cfg.control.requestTimeoutSeconds,
    persistMode: (m) => saveState(cfg.stateFile, { mode: m }),
  });

  const session = createPtySession({
    shell: cfg.terminal.shell,
    cwd: cfg.terminal.cwd,
    cols: cfg.terminal.cols,
    rows: cfg.terminal.rows,
    env: cfg.terminal.env,
    maxBufferBytes: cfg.buffer.maxBytes,
  });

  const refreshCookieName = cfg.cookie.name + '_rt';

  const authenticate = noAuth
    ? () => ({ username: 'nobody', role: 'admin' })
    : (req) => {
        const payload = verifySession(parseCookies(req.headers.cookie)[cfg.cookie.name], secret, 'access');
        return payload ? { username: payload.sub, role: payload.role, accessExp: payload.exp } : null;
      };

  const publicDir = fileURLToPath(new URL('../public', import.meta.url));

  const terminal = attachWebSocket({ config: cfg, session, control, authenticate, offerShared, authOn });

  const refresh = noAuth
    ? () => ({ accessExpiresAt: null })
    : (req) => {
        const token = parseCookies(req.headers.cookie)[refreshCookieName];
        const payload = verifySession(token, secret, 'refresh');
        if (!payload) return null;
        // Re-check the roster: a deleted user can't refresh forever, and a role change lands within one access-TTL.
        const cur = listUsers(cfg.usersFile).find((u) => u.username === payload.sub);
        if (!cur) return null;
        const now = Math.floor(Date.now() / 1000);
        const exp = now + cfg.cookie.accessTtlSeconds;
        const setCookie = serializeCookie(
          cfg.cookie.name,
          signSession({ sub: cur.username, role: cur.role, typ: 'access' }, secret, cfg.cookie.accessTtlSeconds),
          { maxAge: cfg.cookie.accessTtlSeconds, secure: cfg.cookie.secure }
        );
        terminal.touchUser(cur.username, exp, cur.role);
        return { setCookie, accessExpiresAt: exp };
      };

  const server = createHttpServer({
    authenticate,
    login: (username, password) => verifyLogin(cfg.usersFile, username, password),
    // Access cookie MUST be first: the CLI tunnel client extracts the first Set-Cookie pair.
    makeSessionCookie: (user) => [
      serializeCookie(
        cfg.cookie.name,
        signSession({ sub: user.username, role: user.role, typ: 'access' }, secret, cfg.cookie.accessTtlSeconds),
        { maxAge: cfg.cookie.accessTtlSeconds, secure: cfg.cookie.secure }
      ),
      serializeCookie(
        refreshCookieName,
        signSession({ sub: user.username, role: user.role, typ: 'refresh' }, secret, cfg.cookie.refreshTtlSeconds),
        { maxAge: cfg.cookie.refreshTtlSeconds, secure: cfg.cookie.secure, path: '/refresh' }
      ),
    ],
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

  if (offerShared) {
    try {
      session.spawn();
    } catch (e) {
      error(`failed to spawn shell: ${e.message}`);
      process.exit(1);
    }
  }

  // hoisted so an abnormal server exit tears Caddy down instead of orphaning the public :8443 listener
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
      try { caddy = startCaddy(process.env.RINNEGAN_ROOT || null, flags); }
      catch (e) { error(e.message); process.exit(1); }
      info('rinnegan HTTPS front (Caddy) starting on https://0.0.0.0:8443 (self-signed)');
      caddy.on('exit', (code, sig) => { error(`caddy exited (code=${code} signal=${sig}); shutting down`); process.exit(code == null ? 1 : code); });
      caddy.on('error', (e) => { error(`failed to start caddy: ${e.message}`); process.exit(1); });
    }
  });
}
