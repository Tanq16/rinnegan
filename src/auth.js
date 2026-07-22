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
    // Bound scrypt params from the untrusted record; keyLength is not capped by maxmem, so an oversized value is a DoS amplifier on every login.
    const kl = record.keyLength;
    if (!Number.isInteger(kl) || kl < 1 || kl > 64) return false;
    const N = record.N;
    if (!Number.isInteger(N) || N < 2 || N > 1048576 || (N & (N - 1)) !== 0) return false;
    const r = record.r;
    if (!Number.isInteger(r) || r < 1 || r > 32) return false;
    const p = record.p;
    if (!Number.isInteger(p) || p < 1 || p > 16) return false;
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(password, salt, kl, { N, r, p });
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
    typ: claims.typ,
    iat: now,
    exp: now + ttlSeconds,
    sid: randomBytes(8).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmac(body, secret).toString('base64url');
}

export function verifySession(token, secret, expectedType) {
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
    if (expectedType !== undefined && payload.typ !== expectedType) return null;
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

export function serializeCookie(name, value, { maxAge, secure, path = '/' }) {
  let cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${path}; HttpOnly; SameSite=Lax`;
  if (secure) cookie += '; Secure';
  return cookie;
}
