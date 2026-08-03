import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from './config.js';
import { validatePort } from './tunnel.js';

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

// An all-digit name is unreachable: /proxy/<segment> resolves a numeric segment as a port before the alias table is ever consulted.
export function validAliasName(name) {
  return typeof name === 'string' && ALIAS_PATTERN.test(name) && !/^\d+$/.test(name);
}

export function sanitizeAliases(raw) {
  const out = Object.create(null);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, port] of Object.entries(raw)) {
    const n = validatePort(port);
    if (validAliasName(name) && n !== null) out[name] = n;
  }
  return out;
}

// Unlike loadConfig, a missing or corrupt file degrades to no aliases instead of throwing: aliases are a convenience, and refusing to boot over them would take the terminal down too.
export function loadAliases(file) {
  try {
    return sanitizeAliases(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return Object.create(null);
  }
}

export function createAliasStore(file) {
  const entries = loadAliases(file);
  const flush = () => atomicWriteFileSync(file, JSON.stringify(entries, null, 2) + '\n', 0o600);
  return {
    entries,
    set(name, port) {
      entries[name] = port;
      flush();
    },
    remove(name) {
      delete entries[name];
      flush();
    },
  };
}
