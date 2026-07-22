import { WebSocketServer } from 'ws';
import { connect } from 'node:net';

// Cap the per-socket send queue so a stalled client's backlog cannot exhaust server memory.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function attachTunnel({ authenticate }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1048576 });

  function pipe(ws, upstream) {
    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      upstream.destroy();
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
    const port = Number(new URL(req.url, 'http://x').searchParams.get('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4400, 'invalid port'));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => pipe(ws, connect(port, '127.0.0.1')));
  }

  return { handleUpgrade };
}
