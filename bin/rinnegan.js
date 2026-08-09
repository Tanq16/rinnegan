#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { setPassword } from '../src/password.js';
import { start } from '../src/server.js';
import { runTunnel, runTunnels, parseTunnelConfig, validatePort } from '../src/tunnel-client.js';

const USAGE = `usage:
  rinnegan serve [--no-auth] [--shell zsh|bash|fish] [--listen <host>:<port>]
  (--no-auth disables all authentication; anyone who reaches the port gets a host shell)
  (--shell overrides terminal.shell from config.json; anything else is a startup error)
  (--listen overrides listen.host and listen.port from config.json; an empty host binds every interface)
  rinnegan tunnel --server <url> --local <port> --remote <port> [--insecure]
  (forwards localhost:<local> to the server's localhost:<remote> over an authenticated WebSocket)
  rinnegan tunnel --config <path> [--insecure]
  (forwards every mapping in a JSON config: { "server": <url>, "ports": ["<local>:<remote>", ...] })
  (--insecure skips TLS verification, for a self-signed proxy cert or a bare IP)
  rinnegan passwd
  (sets the single login password, creating auth.json on first use)
  rinnegan version
`;

const BOOLEAN_FLAGS = new Set(['no-auth', 'insecure']);

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
  if (password.length === 0) throw new Error('password must not be empty');
  return password;
}

async function passwd() {
  const cfg = loadConfig();
  const password = await promptNewPassword();
  await setPassword(cfg.authFile, password);
}

function loadTunnelConfig(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`failed to read tunnel config ${path}: ${e.message}`); }
  return parseTunnelConfig(raw);
}

async function tunnel(flags) {
  const insecure = flags.insecure === true;
  if (flags.config) {
    const { server, mappings } = loadTunnelConfig(flags.config);
    const password = await promptPassword(`Password for ${server}: `);
    await runTunnels({ server, mappings, password, insecure });
    return;
  }
  const server = requireFlag(flags, 'server');
  const localPort = validatePort(requireFlag(flags, 'local'));
  if (localPort === null) throw new Error('--local must be a port 1-65535');
  const remotePort = validatePort(requireFlag(flags, 'remote'));
  if (remotePort === null) throw new Error('--remote must be a port 1-65535');
  const password = await promptPassword(`Password for ${server}: `);
  await runTunnel({ server, localPort, remotePort, password, insecure });
}

function printVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.length === 0 ? 'serve' : positional.join(' ');

  switch (command) {
    case 'serve':
      return start(loadConfig(), flags);
    case 'tunnel':
      return tunnel(flags);
    case 'passwd':
      return passwd();
    case 'version':
      return printVersion();
    default:
      usageExit();
  }
}

main().catch((e) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
