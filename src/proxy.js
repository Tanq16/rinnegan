import { request } from 'node:http';
import { connect } from 'node:net';
import { pipeline } from 'node:stream';
import { validatePort } from './tunnel.js';

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate'];
export const REQUEST_DROP = new Set([...HOP_BY_HOP, 'upgrade']);
// Connection and Upgrade are the handshake itself, so the upgrade relay forwards them where a plain request must not.
export const UPGRADE_DROP = new Set(HOP_BY_HOP.filter((h) => h !== 'connection'));
const RESPONSE_DROP = new Set(HOP_BY_HOP);

export function splitProxyPath(url) {
  const base = '/proxy/';
  if (!url.startsWith(base)) return null;
  const after = url.slice(base.length);
  const cut = after.search(/[/?#]/);
  const segment = cut === -1 ? after : after.slice(0, cut);
  if (!segment) return null;
  return { segment, prefix: base + segment, rest: cut === -1 ? '' : after.slice(cut) };
}

// Without the trailing slash every relative URL the upstream emits resolves one segment too high, so /proxy/ide must land on /proxy/ide/.
export function needsTrailingSlash(rest) {
  return rest === '' || rest.startsWith('?') || rest.startsWith('#');
}

export function resolveTarget(segment, aliases) {
  if (/^\d+$/.test(segment)) return validatePort(segment);
  return Object.hasOwn(aliases, segment) ? aliases[segment] : null;
}

export function stripCookies(header, names) {
  if (typeof header !== 'string' || header === '') return null;
  const kept = header.split(';').filter((part) => {
    const trimmed = part.trim();
    if (!trimmed) return false;
    const eq = trimmed.indexOf('=');
    return !names.includes(eq === -1 ? trimmed : trimmed.slice(0, eq));
  });
  return kept.length ? kept.map((p) => p.trim()).join('; ') : null;
}

export function rewriteLocation(value, prefix, port) {
  if (typeof value !== 'string' || value === '' || value.startsWith('//')) return value;
  if (value.startsWith('/')) return prefix + value;
  try {
    const u = new URL(value);
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(port)) {
      return prefix + u.pathname + u.search + u.hash;
    }
  } catch {}
  return value;
}

// Left at Path=/ an upstream cookie would be sent to every rinnegan route and collide with every other proxied app's cookies.
export function rewriteCookiePath(cookie, prefix) {
  if (typeof cookie !== 'string') return cookie;
  let found = false;
  const parts = cookie.split(';').map((part) => {
    const m = /^(\s*)path\s*=\s*(.*)$/i.exec(part);
    if (!m) return part;
    const value = m[2].trim();
    if (!value.startsWith('/')) return part;
    found = true;
    return `${m[1]}Path=${prefix}${value}`;
  });
  return found ? parts.join(';') : `${cookie}; Path=${prefix}/`;
}

// A hand-serialized upgrade request would let a CR/LF in any value inject extra headers upstream.
const injectable = (v) => typeof v === 'string' && /[\r\n]/.test(v);

export function forwardHeaders(headers, { drop, cookieNames, prefix, port, proto, remote }) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (drop.has(key.toLowerCase()) || key.toLowerCase() === 'cookie') continue;
    if (Array.isArray(value) ? value.some(injectable) : injectable(value)) continue;
    out[key] = value;
  }
  const cookie = stripCookies(headers.cookie, cookieNames);
  if (cookie) out.cookie = cookie;
  // Dev servers commonly reject an unfamiliar Host as DNS rebinding, so the upstream sees its own address and the original arrives as X-Forwarded-Host.
  if (headers.host) out['x-forwarded-host'] = headers.host;
  out.host = `127.0.0.1:${port}`;
  out['x-forwarded-proto'] = headers['x-forwarded-proto'] || proto;
  out['x-forwarded-prefix'] = prefix;
  if (!out['x-forwarded-for'] && remote) out['x-forwarded-for'] = remote;
  return out;
}

export function responseHeaders(headers, prefix, port) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (RESPONSE_DROP.has(lower)) continue;
    if (lower === 'location') out[key] = rewriteLocation(value, prefix, port);
    else if (lower === 'set-cookie') out[key] = (Array.isArray(value) ? value : [value]).map((c) => rewriteCookiePath(c, prefix));
    else out[key] = value;
  }
  return out;
}

export function serializeUpgrade(method, path, headers) {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [key, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

export function attachProxy({ aliases, cookieNames, secure }) {
  const proto = secure ? 'https' : 'http';

  function fail(res, status, message) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
    res.end(message);
  }

  function handleRequest(req, res, split) {
    const port = resolveTarget(split.segment, aliases);
    if (port === null) return fail(res, 404, 'no such proxy target');
    if (needsTrailingSlash(split.rest)) {
      res.writeHead(302, { Location: `${split.prefix}/${split.rest}` });
      return res.end();
    }
    const headers = forwardHeaders(req.headers, {
      drop: REQUEST_DROP,
      cookieNames,
      prefix: split.prefix,
      port,
      proto,
      remote: req.socket.remoteAddress,
    });
    const upstream = request({ host: '127.0.0.1', port, method: req.method, path: split.rest, headers }, (up) => {
      res.writeHead(up.statusCode, responseHeaders(up.headers, split.prefix, port));
      pipeline(up, res, () => {});
    });
    upstream.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') return fail(res, 502, `nothing is listening on 127.0.0.1:${port}`);
      if (e.code === 'ETIMEDOUT') return fail(res, 504, `127.0.0.1:${port} timed out`);
      fail(res, 502, `proxy to 127.0.0.1:${port} failed`);
    });
    pipeline(req, upstream, () => {});
  }

  function handleUpgrade(req, socket, head, split, session) {
    const port = resolveTarget(split.segment, aliases);
    if (port === null) return socket.destroy();
    const upstream = connect(port, '127.0.0.1');
    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      clearTimeout(expiryTimer);
      upstream.destroy();
      socket.destroy();
    };
    // No fuse and no grace as the terminal socket gets: a dropped proxy socket costs nothing because the upstream app reconnects, and a still-valid cookie makes that invisible.
    const expiryTimer = typeof session.accessExp === 'number'
      ? setTimeout(teardown, (session.accessExp + 60) * 1000 - Date.now())
      : null;
    upstream.on('connect', () => {
      const headers = forwardHeaders(req.headers, {
        drop: UPGRADE_DROP,
        cookieNames,
        prefix: split.prefix,
        port,
        proto,
        remote: req.socket.remoteAddress,
      });
      upstream.write(serializeUpgrade(req.method, split.rest || '/', headers));
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    for (const s of [upstream, socket]) {
      s.on('error', teardown);
      s.on('close', teardown);
    }
  }

  return { handleRequest, handleUpgrade };
}
