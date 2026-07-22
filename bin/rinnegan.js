#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { addUser, setPassword, listUsers } from '../src/users.js';
import { start } from '../src/server.js';
import { runTunnel, validatePort } from '../src/tunnel-client.js';

const USAGE = `usage:
  rinnegan serve [--https] [--no-auth] [--refresh-caddyfile]
  (--https serves via the bundled Caddy with a self-signed cert on :8443)
  (--no-auth disables all authentication; anyone who reaches the port gets a host shell)
  (--refresh-caddyfile overwrites the runtime Caddyfile from the shipped template, discarding local edits)
  rinnegan tunnel --server <url> --local <port> --remote <port> --username <name> [--insecure]
  (forwards localhost:<local> to the server's localhost:<remote> over an authenticated WebSocket)
  (--insecure skips TLS verification, for the bundled self-signed Caddy cert or a bare IP)
  rinnegan user add --username <name> [--role admin|user]
  rinnegan user passwd --username <name>
  rinnegan user list
  rinnegan version
`;

const BOOLEAN_FLAGS = new Set(['https', 'no-auth', 'refresh-caddyfile', 'insecure']);

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

async function userAdd(flags) {
  const cfg = loadConfig();
  const username = requireFlag(flags, 'username');
  const role = flags.role ?? 'user';
  if (role !== 'admin' && role !== 'user') throw new Error("--role must be 'admin' or 'user'");
  const password = await promptNewPassword();
  await addUser(cfg.usersFile, username, role, password);
}

async function userPasswd(flags) {
  const cfg = loadConfig();
  const username = requireFlag(flags, 'username');
  const password = await promptNewPassword();
  await setPassword(cfg.usersFile, username, password);
}

async function tunnel(flags) {
  const server = requireFlag(flags, 'server');
  const username = requireFlag(flags, 'username');
  const localPort = validatePort(requireFlag(flags, 'local'));
  if (localPort === null) throw new Error('--local must be a port 1-65535');
  const remotePort = validatePort(requireFlag(flags, 'remote'));
  if (remotePort === null) throw new Error('--remote must be a port 1-65535');
  const password = await promptPassword(`Password for ${username}: `);
  await runTunnel({ server, localPort, remotePort, username, password, insecure: flags.insecure === true });
}

function userList() {
  const cfg = loadConfig();
  for (const user of listUsers(cfg.usersFile)) {
    process.stdout.write(`${user.username}\t${user.role}\n`);
  }
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
    case 'user add':
      return userAdd(flags);
    case 'user passwd':
      return userPasswd(flags);
    case 'user list':
      return userList();
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
