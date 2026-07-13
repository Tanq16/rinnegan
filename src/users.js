// Re-reads the users file per call so credential changes take effect without restart.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { hashPassword, verifyPassword } from './auth.js';

// Unknown users still pay the scrypt cost to avoid a user-enumeration timing signal.
const DUMMY_RECORD = {
  algorithm: 'scrypt',
  salt: Buffer.alloc(16).toString('base64'),
  hash: Buffer.alloc(64).toString('base64'),
  keyLength: 64,
  N: 16384,
  r: 8,
  p: 1,
};

export function loadUsers(usersFile) {
  let raw;
  try {
    raw = readFileSync(usersFile, 'utf8');
  } catch (e) {
    throw new Error(`cannot read users file ${usersFile}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in users file ${usersFile}: ${e.message}`);
  }
  if (!data || !Array.isArray(data.users)) {
    throw new Error(`users file ${usersFile} must contain a "users" array`);
  }
  for (const u of data.users) {
    if (!u || typeof u.username !== 'string' || u.username.length === 0) {
      throw new Error(`users file ${usersFile}: entry missing username`);
    }
    if (u.role !== 'admin' && u.role !== 'user') {
      throw new Error(`users file ${usersFile}: user "${u.username}" has invalid role`);
    }
    if (!u.password || typeof u.password !== 'object') {
      throw new Error(`users file ${usersFile}: user "${u.username}" has no password record`);
    }
  }
  return data;
}

export async function verifyLogin(usersFile, username, password) {
  const { users } = loadUsers(usersFile);
  const user = users.find((u) => u.username === username);
  if (!user) {
    await verifyPassword(password, DUMMY_RECORD);
    return null;
  }
  const ok = await verifyPassword(password, user.password);
  return ok ? { username: user.username, role: user.role } : null;
}

async function writeUsers(usersFile, data) {
  const dir = path.dirname(usersFile);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.users-${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, usersFile);
}

export async function addUser(usersFile, username, role, password) {
  if (typeof username !== 'string' || username.length === 0) {
    throw new Error('username must be a non-empty string');
  }
  if (role !== 'admin' && role !== 'user') {
    throw new Error(`invalid role: ${role}`);
  }
  const data = existsSync(usersFile) ? loadUsers(usersFile) : { users: [] };
  if (data.users.some((u) => u.username === username)) {
    throw new Error(`user exists: ${username}`);
  }
  data.users.push({ username, role, password: await hashPassword(password) });
  await writeUsers(usersFile, data);
}

export async function setPassword(usersFile, username, password) {
  const data = loadUsers(usersFile);
  const user = data.users.find((u) => u.username === username);
  if (!user) throw new Error(`no such user: ${username}`);
  user.password = await hashPassword(password);
  await writeUsers(usersFile, data);
}

export function listUsers(usersFile) {
  return loadUsers(usersFile).users.map((u) => ({ username: u.username, role: u.role }));
}
