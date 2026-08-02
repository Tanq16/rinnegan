// Re-reads the auth file per call so a password change takes effect without a restart.
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { hashPassword, verifyPassword } from './auth.js';

export function loadRecord(authFile) {
  let raw;
  try {
    raw = readFileSync(authFile, 'utf8');
  } catch (e) {
    throw new Error(`cannot read auth file ${authFile}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in auth file ${authFile}: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || !data.password || typeof data.password !== 'object') {
    throw new Error(`auth file ${authFile} must contain a "password" record`);
  }
  return data.password;
}

// Returns the record (the fingerprint's source) rather than a boolean, so a login costs one read.
export async function verify(authFile, password) {
  const record = loadRecord(authFile);
  return (await verifyPassword(password, record)) ? record : null;
}

export async function setPassword(authFile, password) {
  const dir = path.dirname(authFile);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.auth-${randomBytes(6).toString('hex')}.tmp`);
  const body = JSON.stringify({ password: await hashPassword(password) }, null, 2) + '\n';
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, authFile);
}

// Keyed with the per-boot signing secret so a token carries nothing derived from the stored hash.
// setPassword regenerates the salt, so rotating even to the same password changes this and invalidates every session.
export function fingerprint(record, secret) {
  return createHmac('sha256', secret).update(String(record.hash)).digest('base64url').slice(0, 16);
}
