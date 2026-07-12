#!/usr/bin/env node
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadState, saveState } from '../src/config.js';
import { parseCookies, verifySession, signSession, serializeCookie } from '../src/auth.js';
import { verifyLogin, addUser, setPassword, listUsers } from '../src/users.js';
import { createPtySession } from '../src/pty.js';
import { createControl } from '../src/control.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocket } from '../src/ws.js';

const USAGE = `usage:
  rinnegan serve [--https] --config <path>
  (--https serves via the bundled Caddy with a self-signed cert on :8443)
  rinnegan user add --config <path> --username <name> [--role admin|user]
  rinnegan user passwd --config <path> --username <name>
  rinnegan user list --config <path>
`;

const BOOLEAN_FLAGS = new Set(['https']);

function usageExit() {
  process.stderr.write(USAGE);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      const value = argv[++i];
      if (value === undefined) {
        process.stderr.write(`missing value for ${arg}\n`);
        usageExit();
      }
      flags[name] = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (!value) {
    process.stderr.write(`missing required flag --${name}\n`);
    usageExit();
  }
  return value;
}

// Reads a line from stdin in raw mode so the password is never echoed.
function promptPassword(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('password prompt requires an interactive terminal'));
      return;
    }
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { // Ctrl-C
          cleanup();
          process.stderr.write('\n');
          reject(new Error('aborted'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function promptNewPassword() {
  const password = await promptPassword('Password: ');
  const confirm = await promptPassword('Confirm password: ');
  if (password !== confirm) throw new Error('passwords do not match');
  return password;
}

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

function serve(configPath, flags = {}) {
  const cfg = loadConfig(configPath);
  const https = flags.https === true;
  if (https) cfg.cookie.secure = true;
  if (https && cfg.listen.port !== 8442) process.stderr.write(`warning: --https bundled Caddyfile proxies to 127.0.0.1:8442 but listen.port is ${cfg.listen.port}; edit the Caddyfile to match\n`);
  const state = loadState(cfg.stateFile);
  // per-boot signing secret: sessions do not survive restarts (spec persists only mode)
  const secret = randomBytes(32).toString('base64');
  const initialMode = state.mode ?? cfg.control.mode;

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
    process.stderr.write(`failed to spawn shell: ${e.message}\n`);
    process.exit(1);
  }

  server.on('error', (e) => {
    process.stderr.write(`server error: ${e.message}\n`);
    process.exit(1);
  });
  server.listen(cfg.listen.port, cfg.listen.host, () => {
    console.log(`rinnegan listening on http://${cfg.listen.host}:${server.address().port}`);
    if (https) {
      let caddy;
      try { caddy = startCaddy(process.env.RINNEGAN_ROOT || null, flags); }
      catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
      console.log('rinnegan HTTPS front (Caddy) starting on https://0.0.0.0:8443 (self-signed)');
      caddy.on('exit', (code, sig) => { process.stderr.write(`caddy exited (code=${code} signal=${sig}); shutting down\n`); process.exit(code == null ? 1 : code); });
      caddy.on('error', (e) => { process.stderr.write(`failed to start caddy: ${e.message}\n`); process.exit(1); });
      const shutdown = () => { try { caddy.kill('SIGTERM'); } catch {} process.exit(0); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    }
  });
}

async function userAdd(configPath, flags) {
  const cfg = loadConfig(configPath);
  const username = requireFlag(flags, 'username');
  const role = flags.role ?? 'user';
  if (role !== 'admin' && role !== 'user') throw new Error("--role must be 'admin' or 'user'");
  const password = await promptNewPassword();
  await addUser(cfg.usersFile, username, role, password);
}

async function userPasswd(configPath, flags) {
  const cfg = loadConfig(configPath);
  const username = requireFlag(flags, 'username');
  const password = await promptNewPassword();
  await setPassword(cfg.usersFile, username, password);
}

function userList(configPath) {
  const cfg = loadConfig(configPath);
  for (const user of listUsers(cfg.usersFile)) {
    process.stdout.write(`${user.username}\t${user.role}\n`);
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (!flags.config) usageExit();
  const configPath = path.resolve(flags.config);
  const command = positional.length === 0 ? 'serve' : positional.join(' ');

  switch (command) {
    case 'serve':
      return serve(configPath, flags);
    case 'user add':
      return userAdd(configPath, flags);
    case 'user passwd':
      return userPasswd(configPath, flags);
    case 'user list':
      return userList(configPath);
    default:
      usageExit();
  }
}

main().catch((e) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
