import http from 'node:http';
import https from 'node:https';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { info, error } from './log.js';
import { validatePort } from './tunnel.js';

export { validatePort };

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

export function parseMapping(entry) {
  const fail = () => { throw new Error(`invalid port mapping: ${JSON.stringify(entry)}`); };
  if (typeof entry === 'number' || (typeof entry === 'string' && !entry.includes(':'))) {
    const port = validatePort(entry);
    if (port === null) fail();
    return { local: port, remote: port };
  }
  const pair = typeof entry === 'string' ? entry.split(':')
    : Array.isArray(entry) ? entry : fail();
  if (pair.length !== 2) fail();
  const local = validatePort(pair[0]);
  const remote = validatePort(pair[1]);
  if (local === null || remote === null) fail();
  return { local, remote };
}

export function parseTunnelConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('tunnel config must be a JSON object');
  }
  if (typeof raw.server !== 'string' || raw.server.trim() === '') {
    throw new Error('tunnel config requires a "server" string');
  }
  let url;
  try { url = new URL(raw.server); }
  catch { throw new Error(`tunnel config "server" is not a valid URL: ${raw.server}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`tunnel config "server" must be an http(s) URL: ${raw.server}`);
  }
  if (!Array.isArray(raw.ports) || raw.ports.length === 0) {
    throw new Error('tunnel config requires a non-empty "ports" array');
  }
  const mappings = raw.ports.map(parseMapping);
  const seen = new Set();
  for (const { local } of mappings) {
    if (seen.has(local)) throw new Error(`duplicate local port ${local} in tunnel config`);
    seen.add(local);
  }
  return { server: raw.server, mappings };
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
    req.setTimeout(15000, () => req.destroy(new Error('login timed out')));
    req.end(body);
  });
}

function pipe(ws, socket, remote, refreshCookie) {
  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    socket.end(); // not destroy(): it drops buffered bytes and truncates the tail
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

export async function runTunnels({ server, mappings, username, password, insecure }) {
  if (!Array.isArray(mappings) || mappings.length === 0) throw new Error('no port mappings to forward');
  const normalized = mappings.map(({ local, remote }) => {
    const l = validatePort(local);
    if (l === null) throw new Error(`invalid local port: ${local}`);
    const r = validatePort(remote);
    if (r === null) throw new Error(`invalid remote port: ${remote}`);
    return { local: l, remote: r };
  });

  const session = { cookie: await login({ server, username, password, insecure }) };
  let refreshing = null;
  function refreshCookie() {
    if (!refreshing) {
      refreshing = login({ server, username, password, insecure })
        .then((c) => { session.cookie = c; info('tunnel session refreshed'); })
        .catch((e) => error(`re-login failed: ${e.message}`))
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  const wsBase = wsBaseFromServer(server);
  const listeners = [];
  try {
    for (const { local, remote } of normalized) {
      const tunnelUrl = `${wsBase}/tunnel?port=${remote}`;
      const listener = createServer((socket) => {
        pipe(new WebSocket(tunnelUrl, { headers: { Cookie: session.cookie }, rejectUnauthorized: !insecure }), socket, remote, refreshCookie);
      });
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(local, '127.0.0.1', resolve);
      });
      info(`forwarding localhost:${local} -> server localhost:${remote} (authenticated as ${username})`);
      listeners.push(listener);
    }
  } catch (e) {
    for (const l of listeners) l.close(); // a late bind failure must not leak the listeners already open
    throw e;
  }
  return listeners;
}

export async function runTunnel({ server, localPort, remotePort, username, password, insecure }) {
  const [listener] = await runTunnels({
    server, username, password, insecure,
    mappings: [{ local: localPort, remote: remotePort }],
  });
  return listener;
}
