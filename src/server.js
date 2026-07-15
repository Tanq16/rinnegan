import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadState, saveState } from './config.js';
import { parseCookies, verifySession, signSession, serializeCookie } from './auth.js';
import { verifyLogin } from './users.js';
import { createPtySession } from './pty.js';
import { createControl } from './control.js';
import { createHttpServer } from './http.js';
import { attachWebSocket } from './ws.js';
import { info, error } from './log.js';

function startCaddy(root, flags) {
  const caddyBin = flags['caddy-bin'] ? path.resolve(flags['caddy-bin'])
    : root ? path.join(root, 'bin', 'caddy') : null;
  const caddyfile = flags['caddyfile'] ? path.resolve(flags['caddyfile'])
    : root ? path.join(root, 'Caddyfile') : null;
  const dataDir = flags['caddy-data'] ? path.resolve(flags['caddy-data'])
    : root ? path.join(root, 'caddy-data') : null;
  if (!caddyBin || !existsSync(caddyBin)) {
    throw new Error(
      `--https requires the bundled Caddy binary; not found at ${caddyBin ?? '<unknown>'}. ` +
      `Run rinnegan from a release bundle, or pass --caddy-bin <path> --caddyfile <path>.`
    );
  }
  if (!caddyfile || !existsSync(caddyfile)) {
    throw new Error(`--https requires a Caddyfile; not found at ${caddyfile ?? '<unknown>'}.`);
  }
  if (!dataDir) throw new Error('--https: could not determine a Caddy data directory; pass --caddy-data <path>.');
  return spawn(caddyBin, ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {
    stdio: 'inherit',
    env: { ...process.env, XDG_DATA_HOME: dataDir, XDG_CONFIG_HOME: dataDir },
  });
}

export function start(cfg, flags = {}) {
  const https = flags.https === true;
  if (https) cfg.cookie.secure = true;
  if (https && cfg.listen.port !== 8442) process.stderr.write(`warning: --https bundled Caddyfile proxies to 127.0.0.1:8442 but listen.port is ${cfg.listen.port}; edit the Caddyfile to match\n`);
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

  const authenticate = (req) => {
    const payload = verifySession(parseCookies(req.headers.cookie)[cfg.cookie.name], secret);
    return payload ? { username: payload.sub, role: payload.role } : null;
  };

  const publicDir = fileURLToPath(new URL('../public', import.meta.url));

  const server = createHttpServer({
    authenticate,
    login: (username, password) => verifyLogin(cfg.usersFile, username, password),
    makeSessionCookie: (user) =>
      serializeCookie(
        cfg.cookie.name,
        signSession({ sub: user.username, role: user.role }, secret, cfg.cookie.ttlSeconds),
        { maxAge: cfg.cookie.ttlSeconds, secure: cfg.cookie.secure }
      ),
    clearSessionCookie: () => serializeCookie(cfg.cookie.name, '', { maxAge: 0, secure: cfg.cookie.secure }),
    publicDir,
  });

  attachWebSocket(server, { config: cfg, session, control, authenticate });

  try {
    session.spawn();
  } catch (e) {
    error(`failed to spawn shell: ${e.message}`);
    process.exit(1);
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
