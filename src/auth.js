// Pure auth helpers: scrypt password records, HMAC-signed session tokens,
// cookie parse/serialize. No file I/O, no logging.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const SCRYPT_DEFAULTS = { keyLength: 64, N: 16384, r: 8, p: 1 };

function scryptAsync(password, salt, keyLength, { N, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N, r, p }, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_DEFAULTS.keyLength, SCRYPT_DEFAULTS);
  return {
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: key.toString('base64'),
    keyLength: SCRYPT_DEFAULTS.keyLength,
    N: SCRYPT_DEFAULTS.N,
    r: SCRYPT_DEFAULTS.r,
    p: SCRYPT_DEFAULTS.p,
  };
}

export async function verifyPassword(password, record) {
  try {
    if (!record || record.algorithm !== 'scrypt') return false;
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(password, salt, record.keyLength, record);
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function hmac(payloadB64url, secret) {
  return createHmac('sha256', secret).update(payloadB64url).digest();
}

export function signSession(claims, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: claims.sub,
    role: claims.role,
    iat: now,
    exp: now + ttlSeconds,
    sid: randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmac(body, secret).toString('base64url');
}

export function verifySession(token, secret) {
  try {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = hmac(body, secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // malformed pair: ignore
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure }) {
  let cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`;
  if (secure) cookie += '; Secure';
  return cookie;
}
