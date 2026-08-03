import { createServer } from 'node:http';
import { serveStatic } from './static.js';
import { handleUpload, handleUploadBatch } from './upload.js';
import { handleDownload } from './download.js';
import { splitProxyPath } from './proxy.js';
import { validAliasName } from './proxies.js';
import { validatePort } from './tunnel.js';
import { error } from './log.js';

const MAX_LOGIN_BODY = 10240;
const MAX_PROXY_BODY = 1024;

// Resolves null when the body exceeds maxBytes (caller responds 413).
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function redirect(res, location, setCookie) {
  const headers = { Location: location };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  res.writeHead(302, headers);
  res.end();
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { Allow: allow, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('method not allowed');
}

function unauthorized(res) {
  // Connection: close — an unauthenticated request's unread body would poison keep-alive
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  res.end('auth required');
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createHttpServer({ authenticate, authOn, login, makeSessionCookie, clearSessionCookie, refresh, publicDir, proxy, aliases }) {
  async function handleLogin(req, res) {
    const body = await readBody(req, MAX_LOGIN_BODY);
    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('payload too large');
      return;
    }
    const params = new URLSearchParams(body);
    const session = await login(params.get('password') ?? '');
    if (session) return redirect(res, '/', makeSessionCookie(session));
    return redirect(res, '/login?error=1');
  }

  function handleRefresh(req, res) {
    const result = refresh(req);
    if (!result) return unauthorized(res);
    // Connection: close — /refresh doesn't drain its body, so an unread body would poison keep-alive.
    const headers = { 'Content-Type': 'application/json', Connection: 'close' };
    if (result.setCookie) headers['Set-Cookie'] = result.setCookie;
    res.writeHead(200, headers);
    res.end(JSON.stringify({ accessExpiresAt: result.accessExpiresAt }));
  }

  async function handleAliasAdd(req, res) {
    const body = await readBody(req, MAX_PROXY_BODY);
    if (body === null) {
      // Connection: close — an over-limit body is left unread, and the remainder would poison keep-alive.
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      return res.end(JSON.stringify({ error: 'payload too large' }));
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    const name = msg?.name;
    const port = validatePort(msg?.port);
    if (!validAliasName(name)) return sendJson(res, 400, { error: 'name must be lowercase letters, digits and dashes, and cannot be all digits' });
    if (port === null) return sendJson(res, 400, { error: 'port must be between 1 and 65535' });
    aliases.set(name, port);
    return sendJson(res, 200, { ...aliases.entries });
  }

  async function route(req, res) {
    let pathname;
    let searchParams;
    try {
      ({ pathname, searchParams } = new URL(req.url, 'http://x'));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const method = req.method;

    if (pathname === '/') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      if (authenticate(req)) return serveStatic(req, res, publicDir, '/index.html');
      return redirect(res, '/login');
    }

    if (pathname === '/login') {
      // Unrouted without auth: there is no password to check, so a POST would only burn a file read and a scrypt derivation per request.
      if (!authOn) return notFound(res);
      if (method === 'GET') {
        if (authenticate(req)) return redirect(res, '/');
        return serveStatic(req, res, publicDir, '/login.html');
      }
      if (method === 'POST') return handleLogin(req, res);
      return methodNotAllowed(res, 'GET, POST');
    }

    if (pathname === '/logout') {
      if (!authOn) return notFound(res);
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return redirect(res, '/login', clearSessionCookie());
    }

    if (pathname === '/refresh') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleRefresh(req, res);
    }

    if (pathname === '/upload') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!authenticate(req)) return unauthorized(res);
      return handleUpload(req, res, searchParams);
    }

    if (pathname === '/upload/batch') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!authenticate(req)) return unauthorized(res);
      return handleUploadBatch(req, res);
    }

    if (pathname === '/download') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
      if (!authenticate(req)) return unauthorized(res);
      return handleDownload(req, res, searchParams);
    }

    if (pathname === '/proxies') {
      if (!proxy) return notFound(res);
      if (!authenticate(req)) return unauthorized(res);
      if (method === 'GET') return sendJson(res, 200, { ...aliases.entries });
      if (method === 'POST') return handleAliasAdd(req, res);
      if (method === 'DELETE') {
        const name = searchParams.get('name') ?? '';
        if (!validAliasName(name)) return sendJson(res, 400, { error: 'invalid name' });
        aliases.remove(name);
        return sendJson(res, 200, { ...aliases.entries });
      }
      return methodNotAllowed(res, 'GET, POST, DELETE');
    }

    // Every method passes through: the upstream owns its own verbs, so no methodNotAllowed gate here.
    if (pathname === '/proxy' || pathname.startsWith('/proxy/')) {
      if (!proxy) return notFound(res);
      if (!authenticate(req)) return unauthorized(res);
      const split = splitProxyPath(req.url);
      if (!split) return notFound(res);
      return proxy.handleRequest(req, res, split);
    }

    if (pathname === '/styles.css' || pathname === '/app.js' || pathname === '/logo.svg' || pathname.startsWith('/vendor/') || pathname.startsWith('/css/') || pathname.startsWith('/fonts/')) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return serveStatic(req, res, publicDir, pathname);
    }

    return notFound(res);
  }

  return createServer((req, res) => {
    route(req, res).catch((err) => {
      // Never log request bodies here (they may contain credentials).
      error(`request error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('server error');
    });
  });
}
