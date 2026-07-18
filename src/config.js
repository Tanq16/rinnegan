import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 8442 },
  cookie: { secure: false, name: 'rinnegan', ttlSeconds: 86400 },
  terminal: {
    shell: '/usr/bin/env zsh -l',
    cwd: null,
    cols: 120,
    rows: 36,
    autoRestartShell: false,
    env: {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    },
  },
  control: { mode: 'soft', staleControllerSeconds: 120, requestTimeoutSeconds: 60 },
  buffer: { maxBytes: 2097152 },
  usersFile: './users.json',
  stateFile: './state.json',
};

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

function atomicWriteFileSync(file, data, mode) {
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

  for (const sec of ['listen', 'cookie', 'terminal', 'control', 'buffer']) {
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
  check(cfg.control.mode === 'fast' || cfg.control.mode === 'soft', "control.mode must be 'fast' or 'soft'");
  check(
    Number.isInteger(cfg.control.staleControllerSeconds) && cfg.control.staleControllerSeconds >= 1,
    'control.staleControllerSeconds must be an integer >= 1'
  );
  check(
    Number.isInteger(cfg.control.requestTimeoutSeconds) && cfg.control.requestTimeoutSeconds >= 1,
    'control.requestTimeoutSeconds must be an integer >= 1'
  );
  check(
    Number.isInteger(cfg.buffer.maxBytes) && cfg.buffer.maxBytes >= 65536,
    'buffer.maxBytes must be an integer >= 65536'
  );
  check(
    Number.isInteger(cfg.cookie.ttlSeconds) && cfg.cookie.ttlSeconds >= 60,
    'cookie.ttlSeconds must be an integer >= 60'
  );
  // cookie.name lands in a Set-Cookie header; restrict to token chars to prevent header/cookie injection.
  check(
    typeof cfg.cookie.name === 'string' && /^[A-Za-z0-9!#$%&'*+._`|~^-]+$/.test(cfg.cookie.name),
    'cookie.name must be a valid cookie token'
  );

  if (cfg.terminal.cwd == null) cfg.terminal.cwd = process.env.HOME || process.cwd();

  cfg.usersFile = path.resolve(dir, cfg.usersFile);
  cfg.stateFile = path.resolve(dir, cfg.stateFile);

  return cfg;
}

function writeStateFile(stateFile, state) {
  atomicWriteFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 0o600);
}

export function loadState(stateFile) {
  let raw;
  try {
    raw = readFileSync(stateFile, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`cannot read state file ${stateFile}: ${e.message}`);
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeStateFile(stateFile, { mode: null });
    return { mode: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in state file ${stateFile}: ${e.message}`);
  }
  if (!isPlainObject(parsed)) return { mode: null };
  // Narrow to the same enum loadConfig enforces so a tampered state file can't inject a trusted mode.
  const m = parsed.mode;
  return { mode: m === 'fast' || m === 'soft' ? m : null };
}

export function saveState(stateFile, state) {
  writeStateFile(stateFile, state);
}
