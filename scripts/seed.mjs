// Seed a rinnegan bundle root with a ready-to-run config.json and users.json.
//
// Usage: node scripts/seed.mjs <bundleRoot>
//
// Writes:
//   <bundleRoot>/config.json  (mode 0644) - listens on 127.0.0.1:8787, cookie name "rinnegan"
//   <bundleRoot>/users.json   (mode 0600) - a single seeded admin/changeme account
//
// The scrypt password hasher is imported from ../src/auth.js so the record
// shape always matches what the running server expects.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEED_USERNAME = 'admin';
const SEED_ROLE = 'admin';
const SEED_PASSWORD = 'changeme';

function usage() {
  process.stderr.write('usage: node scripts/seed.mjs <bundleRoot>\n');
  process.exit(2);
}

const bundleRootArg = process.argv[2];
if (!bundleRootArg) usage();

const bundleRoot = path.resolve(bundleRootArg);

// config.json: seeded, ready-to-run. cwd omitted so it defaults to $HOME at runtime.
const config = {
  listen: { host: '127.0.0.1', port: 8787 },
  cookie: { secure: false, name: 'rinnegan', ttlSeconds: 86400 },
  terminal: {
    shell: '/usr/bin/env bash -l',
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

const passwordRecord = await hashPassword(SEED_PASSWORD);
const users = {
  users: [
    {
      username: SEED_USERNAME,
      role: SEED_ROLE,
      password: passwordRecord,
    },
  ],
};

const configPath = path.join(bundleRoot, 'config.json');
const usersPath = path.join(bundleRoot, 'users.json');

writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
writeFileSync(usersPath, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });

process.stdout.write(`seeded config.json (0644): ${configPath}\n`);
process.stdout.write(`seeded users.json  (0600): ${usersPath}\n`);
