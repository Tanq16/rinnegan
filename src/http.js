import { createServer } from 'node:http';
import { serveStatic } from './static.js';
import { handleUpload, handleUploadBatch } from './upload.js';
import { handleDownload } from './download.js';
import { splitProxyPath, refererTarget } from './proxy.js';
import { NS } from './paths.js';
import { error } from './log.js';

const MAX_LOGIN_BODY = 10240;

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

export function createHttpServer({ authenticate, authOn, login, makeSessionCookie, clearSessionCookie, refresh, publicDir, proxy }) {
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
    return redirect(res, NS + '/login?error=1');
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
      return redirect(res, NS + '/login');
    }

    if (pathname.startsWith(NS + '/')) {
      const sub = pathname.slice(NS.length);

      if (sub === '/login') {
        // Unrouted without auth: there is no password to check, so a POST would only burn a file read and a scrypt derivation per request.
        if (!authOn) return notFound(res);
        if (method === 'GET') {
          if (authenticate(req)) return redirect(res, '/');
          return serveStatic(req, res, publicDir, '/login.html');
        }
        if (method === 'POST') return handleLogin(req, res);
        return methodNotAllowed(res, 'GET, POST');
      }

      if (sub === '/logout') {
        if (!authOn) return notFound(res);
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return redirect(res, NS + '/login', clearSessionCookie());
      }

      if (sub === '/refresh') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return handleRefresh(req, res);
      }

      if (sub === '/upload') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!authenticate(req)) return unauthorized(res);
        return handleUpload(req, res, searchParams);
      }

      if (sub === '/upload/batch') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!authenticate(req)) return unauthorized(res);
        return handleUploadBatch(req, res);
      }

      if (sub === '/download') {
        if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
        if (!authenticate(req)) return unauthorized(res);
        return handleDownload(req, res, searchParams);
      }

      // Every method passes through: the upstream owns its own verbs, so no methodNotAllowed gate here.
      if (sub === '/proxy' || sub.startsWith('/proxy/')) {
        if (!proxy) return notFound(res);
        if (!authenticate(req)) return unauthorized(res);
        const split = splitProxyPath(req.url);
        if (!split) return notFound(res);
        return proxy.handleRequest(req, res, split);
      }

      if (sub === '/styles.css' || sub === '/app.js' || sub === '/logo.svg' || sub.startsWith('/vendor/') || sub.startsWith('/css/') || sub.startsWith('/fonts/')) {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return serveStatic(req, res, publicDir, sub);
      }

      return notFound(res);
    }

    // Last resort: nothing outside the namespace is rinnegan's, so an unmatched path can only be an upstream's root-relative URL, which lost its prefix when the browser resolved it against the origin. 307 rather than 302 so a POST keeps its method and body.
    if (proxy) {
      const prefix = refererTarget(req.headers.referer);
      if (prefix) {
        if (!authenticate(req)) return unauthorized(res);
        res.writeHead(307, { Location: prefix + req.url });
        return res.end();
      }
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
