#!/usr/bin/env node
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadState, saveState } from '../src/config.js';
import { parseCookies, verifySession, signSession, serializeCookie } from '../src/auth.js';
import { verifyLogin, addUser, setPassword, listUsers } from '../src/users.js';
import { createPtySession } from '../src/pty.js';
import { createControl } from '../src/control.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocket } from '../src/ws.js';

const USAGE = `usage:
  rinnegan serve --config <path>
  rinnegan user add --config <path> --username <name> [--role admin|user]
  rinnegan user passwd --config <path> --username <name>
  rinnegan user list --config <path>
`;

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
      const value = argv[++i];
      if (value === undefined) {
        process.stderr.write(`missing value for ${arg}\n`);
        usageExit();
      }
      flags[arg.slice(2)] = value;
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

function serve(configPath) {
  const cfg = loadConfig(configPath);
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
      return serve(configPath);
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
