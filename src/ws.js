import { WebSocketServer } from 'ws';

const STALE_MS = 90000;
const PING_INTERVAL_MS = 25000;

export function attachWebSocket(httpServer, { config, session, control, authenticate }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1048576 });
  const sockets = new Map(); // ws -> { username, role, lastSeen }

  function userSocketCount(username) {
    let n = 0;
    for (const meta of sockets.values()) if (meta.username === username) n++;
    return n;
  }

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of sockets.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  // A stalled client is otherwise only reaped by the 90s stale terminate; cap the
  // per-socket send queue so fast PTY output cannot exhaust server memory first.
  // The terminated client reconnects and recovers via buffer replay.
  const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

  function broadcastBinary(buf) {
    for (const ws of sockets.keys()) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
      else ws.send(buf, { binary: true });
    }
  }

  function sendToUser(username, obj) {
    if (!username) return;
    const payload = JSON.stringify(obj);
    for (const [ws, meta] of sockets) {
      if (meta.username === username && ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  function stateSnapshot() {
    const s = control.getState();
    return { controller: s.controller, mode: s.mode, viewers: sockets.size, pending: s.pending };
  }

  function broadcastState() {
    broadcast({ t: 'state', ...stateSnapshot() });
  }

  function doRestart(requester) {
    try {
      session.restart(() => broadcastBinary(Buffer.from('\x1bc'))); // RIS between clear and respawn
      broadcast({ t: 'size', ...session.getSize() });
      broadcastState();
    } catch (e) {
      if (requester) send(requester, { t: 'error', msg: 'restart failed: ' + e.message });
      broadcast({ t: 'ended' });
    }
  }

  session.onData((chunk) => broadcastBinary(chunk));
  session.onExit(() => {
    broadcast({ t: 'ended' });
    broadcastState();
    if (config.terminal.autoRestartShell) doRestart(null);
  });

  control.subscribe((kind, data) => {
    if (kind === 'state') broadcastState();
    else if (kind === 'request') sendToUser(control.getState().controller, { t: 'request', from: data.from });
  });

  function handleMessage(ws, meta, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { t: 'error', msg: 'bad message' });
    }
    if (!msg || typeof msg.t !== 'string') return send(ws, { t: 'error', msg: 'bad message' });
    const isAdmin = meta.role === 'admin';

    switch (msg.t) {
      case 'input':
        // non-controller input is silently ignored (spec: no error spam)
        if (control.isController(meta.username) && typeof msg.data === 'string' && session.isRunning()) {
          session.write(msg.data);
        }
        break;
      case 'resize': {
        if (!control.isController(meta.username) && !isAdmin) {
          return send(ws, { t: 'error', msg: 'not allowed' });
        }
        const { cols, rows } = msg;
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 200) {
          return send(ws, { t: 'error', msg: 'invalid size' });
        }
        session.resize(cols, rows);
        broadcast({ t: 'size', cols, rows });
        break;
      }
      case 'take':
        if (!control.take(meta.username, isAdmin)) {
          send(ws, { t: 'error', msg: 'control held; request it' });
        }
        break;
      case 'request':
        control.request(meta.username);
        break;
      case 'grant':
        if (typeof msg.to !== 'string' || !control.grant(meta.username, msg.to, isAdmin)) {
          send(ws, { t: 'error', msg: 'cannot grant' });
        }
        break;
      case 'deny':
        control.deny(meta.username, isAdmin);
        break;
      case 'release':
        control.release(meta.username, isAdmin);
        break;
      case 'mode':
        if (!isAdmin) return send(ws, { t: 'error', msg: 'admin only' });
        if (msg.mode !== 'fast' && msg.mode !== 'soft') return send(ws, { t: 'error', msg: 'invalid mode' });
        control.setMode(msg.mode);
        break;
      case 'restart':
        if (!isAdmin) return send(ws, { t: 'error', msg: 'admin only' });
        doRestart(ws);
        break;
      case 'kickAll':
        if (!isAdmin) return send(ws, { t: 'error', msg: 'admin only' });
        for (const s of [...sockets.keys()]) s.close(4000, 'kicked');
        break;
      case 'hb':
        break; // lastSeen already updated on receipt
      default:
        send(ws, { t: 'error', msg: 'bad message' });
    }
  }

  function onConnection(ws, user) {
    const meta = { username: user.username, role: user.role, lastSeen: Date.now() };
    // connected() may auto-assign control (spec First User Behavior) and must not
    // emit, or a state frame would precede this socket's hello. Register before
    // composing hello so stateSnapshot() counts this socket.
    if (userSocketCount(meta.username) === 0) control.connected(meta.username);
    sockets.set(ws, meta);
    const buf = session.getBuffer();
    send(ws, {
      t: 'hello',
      you: { username: user.username, role: user.role },
      size: session.getSize(),
      state: stateSnapshot(),
      bufferBytes: buf.length,
    });
    if (buf.length > 0 && ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
    if (!session.isRunning()) send(ws, { t: 'ended' });
    broadcastState();

    ws.on('message', (data, isBinary) => {
      meta.lastSeen = Date.now();
      if (isBinary) return; // binary frames from clients are ignored
      handleMessage(ws, meta, data.toString());
    });
    ws.on('pong', () => {
      meta.lastSeen = Date.now();
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (!sockets.has(ws)) return;
      sockets.delete(ws);
      if (userSocketCount(meta.username) === 0) control.disconnected(meta.username);
      broadcastState();
    });
  }

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Auth strictly before any protocol activity; bare handshake only carries the close code.
    const user = authenticate(req);
    if (!user) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'auth required'));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
  });

  // runs for the life of the process; the server has no graceful-shutdown path
  setInterval(() => {
    const now = Date.now();
    for (const [ws, meta] of sockets) {
      if (now - meta.lastSeen > STALE_MS) ws.terminate();
      else ws.ping();
    }
  }, PING_INTERVAL_MS);
}
