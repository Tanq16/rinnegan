import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 8442 },
  cookie: { secure: false, name: 'rinnegan', accessTtlSeconds: 10800, refreshTtlSeconds: 604800 },
  terminal: {
    shell: '/usr/bin/env zsh -l',
    cwd: null,
    cols: 120,
    rows: 36,
    env: {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    },
  },
  authFile: './auth.json',
};

const SHELLS = ['zsh', 'bash', 'fish'];

// An unknown name is a startup error, never a silent fallback: landing in the wrong shell reads as a broken config.
export function resolveShell(name) {
  if (!SHELLS.includes(name)) {
    throw new Error(`--shell must be one of ${SHELLS.join(', ')}; set terminal.shell in config.json for anything else`);
  }
  return `/usr/bin/env ${name} -l`;
}

export function resolveListen(value) {
  const m = typeof value === 'string' ? value.match(/^(.*):(\d+)$/) : null;
  const port = m ? Number(m[2]) : NaN;
  if (!m || port > 65535) {
    throw new Error('--listen must be host:port with port 0-65535, like 0.0.0.0:8442 or :8442');
  }
  // Anchoring the port to the trailing digit run splits at the last colon, so an IPv6 literal keeps its own; Node's listen wants it unbracketed.
  const host = m[1].trim().replace(/^\[(.*)\]$/, '$1');
  return { host: host === '' ? '0.0.0.0' : host, port };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    // Skip prototype-polluting keys: config injecting __proto__ could rewrite the config object's prototype.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function check(cond, msg) {
  if (!cond) throw new Error('invalid config: ' + msg);
}

export function atomicWriteFileSync(file, data, mode) {
  const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
}

export function configDir() {
  const home = os.homedir();
  if (!home || !path.isAbsolute(home)) {
    throw new Error('cannot determine an absolute home directory; set HOME to an absolute path');
  }
  return path.join(home, '.config', 'rinnegan');
}

export function loadConfig() {
  const dir = configDir();
  const configFile = path.join(dir, 'config.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let raw;
  try {
    raw = readFileSync(configFile, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`cannot read config file ${configFile}: ${e.message}`);
    raw = JSON.stringify(DEFAULTS, null, 2) + '\n';
    atomicWriteFileSync(configFile, raw, 0o600);
  }
  let user;
  try {
    user = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in config file ${configFile}: ${e.message}`);
  }
  check(isPlainObject(user), 'config must be a JSON object');

  const cfg = deepMerge(structuredClone(DEFAULTS), user);

  for (const sec of ['listen', 'cookie', 'terminal']) {
    check(isPlainObject(cfg[sec]), sec + ' must be an object');
  }

  check(
    Number.isInteger(cfg.listen.port) && cfg.listen.port >= 0 && cfg.listen.port <= 65535,
    'listen.port must be an integer between 0 and 65535'
  );
  check(
    typeof cfg.listen.host === 'string' && cfg.listen.host.trim() !== '',
    'listen.host must be a non-empty string'
  );
  check(
    typeof cfg.terminal.shell === 'string' && cfg.terminal.shell.trim() !== '',
    'terminal.shell must be a non-empty string'
  );
  check(Number.isInteger(cfg.terminal.cols) && cfg.terminal.cols >= 1, 'terminal.cols must be an integer >= 1');
  check(Number.isInteger(cfg.terminal.rows) && cfg.terminal.rows >= 1, 'terminal.rows must be an integer >= 1');
  // Cap it: the refresh setTimeout (~accessTtl*1000 ms) hot-loops /refresh if it exceeds Node's ~24.85-day timer limit and clamps to ~1ms.
  check(
    Number.isInteger(cfg.cookie.accessTtlSeconds) && cfg.cookie.accessTtlSeconds >= 60 && cfg.cookie.accessTtlSeconds <= 604800,
    'cookie.accessTtlSeconds must be an integer between 60 and 604800'
  );
  check(
    Number.isInteger(cfg.cookie.refreshTtlSeconds) && cfg.cookie.refreshTtlSeconds >= 60,
    'cookie.refreshTtlSeconds must be an integer >= 60'
  );
  // cookie.name lands in a Set-Cookie header; restrict to token chars to prevent header/cookie injection.
  check(
    typeof cfg.cookie.name === 'string' && /^[A-Za-z0-9!#$%&'*+._`|~^-]+$/.test(cfg.cookie.name),
    'cookie.name must be a valid cookie token'
  );

  check(
    typeof cfg.authFile === 'string' && cfg.authFile.trim() !== '',
    'authFile must be a non-empty string'
  );

  if (cfg.terminal.cwd == null) cfg.terminal.cwd = process.env.HOME || process.cwd();

  cfg.authFile = path.resolve(dir, cfg.authFile);

  return cfg;
}
