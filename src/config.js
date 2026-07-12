import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

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
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function check(cond, msg) {
  if (!cond) throw new Error('invalid config: ' + msg);
}

export function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new Error(`cannot read config file ${abs}: ${e.message}`);
  }
  let user;
  try {
    user = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in config file ${abs}: ${e.message}`);
  }
  check(isPlainObject(user), 'config must be a JSON object');

  const cfg = deepMerge(structuredClone(DEFAULTS), user);

  check(
    Number.isInteger(cfg.listen.port) && cfg.listen.port >= 0 && cfg.listen.port <= 65535,
    'listen.port must be an integer between 0 and 65535'
  );
  check(
    typeof cfg.terminal.shell === 'string' && cfg.terminal.shell.trim() !== '',
    'terminal.shell must be a non-empty string'
  );
  check(Number.isInteger(cfg.terminal.cols) && cfg.terminal.cols >= 1, 'terminal.cols must be an integer >= 1');
  check(Number.isInteger(cfg.terminal.rows) && cfg.terminal.rows >= 1, 'terminal.rows must be an integer >= 1');
  check(cfg.control.mode === 'fast' || cfg.control.mode === 'soft', "control.mode must be 'fast' or 'soft'");
  check(
    Number.isInteger(cfg.buffer.maxBytes) && cfg.buffer.maxBytes >= 65536,
    'buffer.maxBytes must be an integer >= 65536'
  );
  check(
    Number.isInteger(cfg.cookie.ttlSeconds) && cfg.cookie.ttlSeconds >= 60,
    'cookie.ttlSeconds must be an integer >= 60'
  );

  if (cfg.terminal.cwd == null) cfg.terminal.cwd = process.env.HOME || process.cwd();

  // Relative users/state paths resolve against the config file's directory.
  const configDir = path.dirname(abs);
  cfg.usersFile = path.resolve(configDir, cfg.usersFile);
  cfg.stateFile = path.resolve(configDir, cfg.stateFile);

  return cfg;
}

function writeStateFile(stateFile, state) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

// spec Session model: the state file persists only the current control mode.
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
  return { mode: parsed.mode ?? null };
}

export function saveState(stateFile, state) {
  writeStateFile(stateFile, state);
}
