import { createServer } from 'node:http';
import { serveStatic } from './static.js';
import { handleUpload, handleUploadBatch } from './upload.js';
import { handleDownload } from './download.js';
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
  // Connection: close — an unauthenticated upload's unread body would poison keep-alive
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  res.end('auth required');
}

export function createHttpServer({ authenticate, login, makeSessionCookie, clearSessionCookie, publicDir }) {
  async function handleLogin(req, res) {
    const body = await readBody(req, MAX_LOGIN_BODY);
    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('payload too large');
      return;
    }
    const params = new URLSearchParams(body);
    const user = await login(params.get('username') ?? '', params.get('password') ?? '');
    if (user) return redirect(res, '/', makeSessionCookie(user));
    return redirect(res, '/login?error=1');
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
      if (method === 'GET') {
        if (authenticate(req)) return redirect(res, '/');
        return serveStatic(req, res, publicDir, '/login.html');
      }
      if (method === 'POST') return handleLogin(req, res);
      return methodNotAllowed(res, 'GET, POST');
    }

    if (pathname === '/logout') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return redirect(res, '/login', clearSessionCookie());
    }

    if (pathname === '/upload') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      const user = authenticate(req);
      if (!user) return unauthorized(res);
      return handleUpload(req, res, searchParams, user.username);
    }

    if (pathname === '/upload/batch') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!authenticate(req)) return unauthorized(res);
      return handleUploadBatch(req, res);
    }

    if (pathname === '/download') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
      const user = authenticate(req);
      if (!user) return unauthorized(res);
      return handleDownload(req, res, searchParams, user.username);
    }

    if (pathname === '/styles.css' || pathname === '/app.js' || pathname.startsWith('/vendor/')) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return serveStatic(req, res, publicDir, pathname);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
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
