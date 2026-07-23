import { WebSocketServer } from 'ws';
import { connect } from 'node:net';

// Cap the per-socket send queue so a stalled client's backlog cannot exhaust server memory.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function validatePort(value) {
  if (!/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export function attachTunnel({ authenticate }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1048576 });

  function pipe(ws, upstream, accessExp) {
    let closed = false;
    // No sliding for tunnels: a reconnect is not destructive, so the client simply reopens on 4401.
    const expiryTimer = typeof accessExp === 'number'
      ? setTimeout(() => ws.close(4401, 'session expired'), (accessExp + 60) * 1000 - Date.now())
      : null;
    const teardown = () => {
      if (closed) return;
      closed = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      upstream.end(); // not destroy(): it drops buffered bytes and truncates the tail
      ws.close();
    };
    upstream.on('data', (chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      // Resume in the send callback (not synchronously) so bufferedAmount reflects the drained queue.
      ws.send(chunk, { binary: true }, () => {
        if (upstream.isPaused() && ws.bufferedAmount <= MAX_BUFFERED_BYTES) upstream.resume();
      });
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) upstream.pause();
    });
    ws.on('message', (data) => {
      if (!upstream.write(data)) ws.pause();
    });
    upstream.on('drain', () => ws.resume());
    upstream.on('close', teardown);
    upstream.on('error', teardown);
    ws.on('close', teardown);
    ws.on('error', teardown);
  }

  function handleUpgrade(req, socket, head) {
    const user = authenticate(req);
    if (!user) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'auth required'));
      return;
    }
    const port = validatePort(new URL(req.url, 'http://x').searchParams.get('port'));
    if (port === null) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4400, 'invalid port'));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => pipe(ws, connect(port, '127.0.0.1'), user.accessExp));
  }

  return { handleUpgrade };
}
