import http from 'node:http';
import https from 'node:https';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { info, error } from './log.js';

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function wsBaseFromServer(serverUrl) {
  const u = new URL(serverUrl);
  const scheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${u.host}`;
}

export function cookieFromSetCookie(setCookie) {
  if (!setCookie) return null;
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof first !== 'string') return null;
  const pair = first.split(';')[0].trim();
  return pair.indexOf('=') > 0 ? pair : null;
}

export function validatePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function login({ server, username, password, insecure }) {
  return new Promise((resolve, reject) => {
    const url = new URL('/login', server);
    const transport = url.protocol === 'https:' ? https : http;
    const body = new URLSearchParams({ username, password }).toString();
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: !insecure,
    }, (res) => {
      res.resume();
      const cookie = cookieFromSetCookie(res.headers['set-cookie']);
      if (res.statusCode === 302 && cookie) resolve(cookie);
      else reject(new Error(`login failed (status ${res.statusCode}); check username and password`));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function runTunnel({ server, localPort, remotePort, username, password, insecure }) {
  const local = validatePort(localPort);
  if (local === null) throw new Error(`invalid local port: ${localPort}`);
  const remote = validatePort(remotePort);
  if (remote === null) throw new Error(`invalid remote port: ${remotePort}`);

  const tunnelUrl = `${wsBaseFromServer(server)}/tunnel?port=${remote}`;
  let cookie = await login({ server, username, password, insecure });

  let refreshing = null;
  function refreshCookie() {
    if (!refreshing) {
      refreshing = login({ server, username, password, insecure })
        .then((c) => { cookie = c; info('tunnel session refreshed'); })
        .catch((e) => error(`re-login failed: ${e.message}`))
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  function pipe(ws, socket) {
    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      socket.destroy();
      ws.close();
    };
    // Hold the client bytes until the ws handshake completes, or the first chunk is sent into a CONNECTING socket and lost.
    socket.pause();
    ws.on('open', () => {
      socket.on('data', (chunk) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(chunk, { binary: true }, () => {
          if (socket.isPaused() && ws.bufferedAmount <= MAX_BUFFERED_BYTES) socket.resume();
        });
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) socket.pause();
      });
      socket.resume();
    });
    ws.on('message', (data) => {
      if (!socket.write(data)) ws.pause();
    });
    socket.on('drain', () => ws.resume());
    ws.on('close', (code) => {
      if (code === 4401) refreshCookie();
      else if (code === 4400) error(`server rejected tunnel to port ${remote} (invalid port)`);
      teardown();
    });
    ws.on('error', teardown);
    socket.on('close', teardown);
    socket.on('error', teardown);
  }

  const listener = createServer((socket) => {
    pipe(new WebSocket(tunnelUrl, { headers: { Cookie: cookie }, rejectUnauthorized: !insecure }), socket);
  });

  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(local, '127.0.0.1', resolve);
  });
  info(`forwarding localhost:${local} -> server localhost:${remote} (authenticated as ${username})`);
  return listener;
}
