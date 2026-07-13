import { WebSocketServer } from 'ws';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { spawnRawPty } from './pty.js';

const STALE_MS = 90000;
const PING_INTERVAL_MS = 25000;

// File uploads land here on the host, named "<5 random alnum>-<safe original>".
// /tmp is deliberate (spec), not os.tmpdir() — the user references these paths in
// a shell/CLI and /tmp is predictable; the OS reaps it, so we never delete them.
const UPLOAD_DIR = '/tmp';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomPrefix() {
  const b = randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i++) s += UPLOAD_ALPHABET[b[i] % 36];
  return s;
}

// Reduce an arbitrary client-supplied name to a basename in [A-Za-z0-9._-] with
// no leading dots. This both blocks traversal / hidden-file writes AND means the
// final path needs no shell quoting — that's what lets the client type it
// straight into the PTY. Extension is preserved (Claude Code keys image detection
// off it). Empty result falls back to "file".
function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return clean || 'file';
}

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

  // Shared-terminal traffic (PTY output, grid size, ended) goes only to sockets
  // viewing the shared session; split sockets keep receiving control-state frames.
  function broadcastShared(obj) {
    const payload = JSON.stringify(obj);
    for (const [ws, meta] of sockets) {
      if (meta.mode === 'shared' && ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  // A stalled client is otherwise only reaped by the 90s stale terminate; cap the
  // per-socket send queue so fast PTY output cannot exhaust server memory first.
  // The terminated client reconnects and recovers via buffer replay.
  const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

  function broadcastBinary(buf) {
    for (const [ws, meta] of sockets) {
      if (meta.mode !== 'shared' || ws.readyState !== ws.OPEN) continue;
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

  // admin restart touches ONLY the shared session; split PTYs are never restarted
  function doRestart(requester) {
    try {
      session.restart(() => broadcastBinary(Buffer.from('\x1bc'))); // RIS between clear and respawn
      broadcastShared({ t: 'size', ...session.getSize() });
      broadcastState();
    } catch (e) {
      if (requester) send(requester, { t: 'error', msg: 'restart failed: ' + e.message });
      broadcastShared({ t: 'ended' });
    }
  }

  session.onData((chunk) => broadcastBinary(chunk));
  session.onExit(() => {
    broadcastShared({ t: 'ended' });
    broadcastState();
    if (config.terminal.autoRestartShell) doRestart(null);
  });

  function clampDim(v, fallback, min, max) {
    const n = Number.isInteger(v) ? v : fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampNatural(cols, rows) {
    return {
      cols: clampDim(cols, config.terminal.cols, 20, 500),
      rows: clampDim(rows, config.terminal.rows, 5, 200),
    };
  }

  // tmux-style min-grid: the shared PTY tracks the elementwise minimum of all
  // attached shared members' natural (viewport-fitting) grids. With no members
  // attached the grid keeps its last value; config cols/rows only seed the
  // initial grid before anyone has ever attached.
  function recomputeGrid() {
    let cols = null;
    let rows = null;
    for (const [ws, meta] of sockets) {
      if (meta.mode !== 'shared' || !meta.natural || ws.readyState !== ws.OPEN) continue;
      if (cols === null || meta.natural.cols < cols) cols = meta.natural.cols;
      if (rows === null || meta.natural.rows < rows) rows = meta.natural.rows;
    }
    if (cols === null) return;
    cols = clampDim(cols, config.terminal.cols, 20, 500);
    rows = clampDim(rows, config.terminal.rows, 5, 200);
    const cur = session.getSize();
    if (cols === cur.cols && rows === cur.rows) return;
    session.resize(cols, rows);
    broadcastShared({ t: 'size', cols, rows });
  }

  // replay path shared by hello and return-to-shared: buffer binary, then the
  // ended notice if the shared shell is down
  function sendSharedReplay(ws, buf) {
    if (buf.length > 0 && ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
    if (!session.isRunning()) send(ws, { t: 'ended' });
  }

  function detachSplit(meta) {
    const p = meta.splitPty;
    meta.splitPty = null;
    for (const d of meta.splitSubs) d.dispose();
    meta.splitSubs = [];
    return p;
  }

  // Kill ONLY the split shell process (pty.kill(); never a process group or its
  // child tree): a tmux server daemonized out of the shell must survive so the
  // user can reattach later — durability is tmux's job, not the app's.
  function killSplit(meta) {
    if (!meta.splitPty) return;
    detachSplit(meta).kill();
  }

  // Attach/return to shared from the lobby or a split. Stores this member's
  // natural grid and recomputes the min-grid BEFORE replying so the mode frame
  // carries the post-attach size. First attach with no controller auto-grants
  // control (spec First User Behavior, moved here from connect).
  function returnToShared(ws, meta, cols, rows) {
    meta.natural = clampNatural(cols, rows);
    meta.mode = 'shared';
    meta.epoch++; // input/resize frames tagged with the lobby/split epoch are now stale
    recomputeGrid();
    const buf = session.getBuffer();
    send(ws, { t: 'mode', mode: 'shared', epoch: meta.epoch, ...session.getSize(), bufferBytes: buf.length });
    sendSharedReplay(ws, buf);
    // a reconnecting controller keeps the stale reservation by re-attaching
    // here — not by merely connecting, which only reaches the lobby
    control.reattached(meta.username);
    if (control.claimIfVacant(meta.username)) broadcastState();
  }

  control.subscribe((kind, data) => {
    if (kind === 'state') broadcastState();
    else if (kind === 'request') sendToUser(control.getState().controller, { t: 'request', from: data.from });
  });

  function handleMessage(ws, meta, raw) {
    if (ws.readyState !== ws.OPEN) return; // closing (e.g. kicked): ignore stragglers
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
        // Frames are routed by the session the user typed INTO, not the socket's
        // current mode: the client echoes the epoch from hello/mode frames, and
        // anything tagged with a pre-switch epoch (keystrokes in flight while a
        // split spawns, exits, or auto-returns to shared) is silently dropped so
        // it can never execute in a session the user was not looking at.
        if (msg.e !== meta.epoch) break;
        if (meta.mode === 'split') {
          // own shell: always writable, no controller gate
          if (typeof msg.data === 'string' && meta.splitPty) meta.splitPty.write(msg.data);
          break;
        }
        if (meta.mode === 'lobby') break; // lobby: no session to type into
        // non-controller input is silently ignored (spec: no error spam)
        if (control.isController(meta.username) && typeof msg.data === 'string' && session.isRunning()) {
          session.write(msg.data);
        }
        break;
      case 'resize': {
        if (msg.e !== meta.epoch) break; // stale: meant for the previous session (see 'input')
        if (meta.mode === 'split') {
          // own pty: clamp and resize, no control gate, no broadcast
          const c = clampDim(msg.cols, config.terminal.cols, 20, 500);
          const r = clampDim(msg.rows, config.terminal.rows, 5, 200);
          if (meta.splitPty) meta.splitPty.resize(c, r);
          break;
        }
        if (meta.mode === 'lobby') break; // lobby contributes nothing to the grid
        // shared: a natural-size report from any member (no controller gate) —
        // it feeds the min-grid; the PTY only resizes if the minimum changed
        meta.natural = clampNatural(msg.cols, msg.rows);
        recomputeGrid();
        break;
      }
      case 'take':
        if (meta.mode !== 'shared') break; // lobby/split sockets hold no control claim
        if (!control.take(meta.username, isAdmin)) {
          send(ws, { t: 'error', msg: 'control held; request it' });
        }
        break;
      case 'request':
        if (meta.mode !== 'shared') break;
        control.request(meta.username);
        break;
      case 'split': {
        if (meta.mode === 'split') break;
        const cols = clampDim(msg.cols, config.terminal.cols, 20, 500);
        const rows = clampDim(msg.rows, config.terminal.rows, 5, 200);
        let p;
        try {
          p = spawnRawPty({
            shell: config.terminal.shell,
            cwd: config.terminal.cwd,
            env: config.terminal.env,
            cols,
            rows,
          });
        } catch (e) {
          return send(ws, { t: 'splitError', msg: e.message });
        }
        // leaving the shared grid: give up control immediately (normal release,
        // not the stale-controller reservation) and withdraw any pending request.
        // Only after a successful spawn — a failed split leaves control untouched.
        // Both are no-ops from the lobby, which holds no claim to give up.
        if (control.isController(meta.username)) control.release(meta.username, false);
        control.cancelRequest(meta.username);
        meta.mode = 'split';
        meta.natural = null; // no longer feeds the shared min-grid
        meta.epoch++; // in-flight shared input must not reach the fresh split shell
        meta.splitPty = p;
        meta.splitSubs = [
          p.onData((data) => {
            if (ws.readyState !== ws.OPEN) return;
            if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
            else ws.send(Buffer.from(data, 'utf8'), { binary: true });
          }),
          p.onExit(({ exitCode }) => {
            if (meta.splitPty !== p) return; // already killed via killSplit
            detachSplit(meta);
            if (ws.readyState !== ws.OPEN) return;
            send(ws, { t: 'splitExited', code: exitCode });
            // the shell died on its own: land in the lobby chooser — returning
            // to shared is an explicit click, never an automatic side effect
            meta.mode = 'lobby';
            meta.epoch++;
            send(ws, { t: 'mode', mode: 'lobby', epoch: meta.epoch });
          }),
        ];
        recomputeGrid(); // a departed shared member may have been the minimum
        send(ws, { t: 'mode', mode: 'split', epoch: meta.epoch, cols, rows });
        break;
      }
      case 'shared':
        if (meta.mode === 'shared') break;
        killSplit(meta); // no-op from the lobby
        returnToShared(ws, meta, msg.cols, msg.rows);
        break;
      case 'lobby': {
        // Detach this viewer back to the chooser. The shared PTY is server-owned
        // and keeps running for everyone else — leaving only stops this socket
        // viewing it; a split shell is ephemeral, so leaving one kills it.
        if (meta.mode === 'lobby') break;
        killSplit(meta); // no-op unless split
        if (control.isController(meta.username)) control.release(meta.username, false);
        control.cancelRequest(meta.username);
        const wasShared = meta.mode === 'shared';
        meta.mode = 'lobby';
        meta.natural = null; // no longer part of the shared min-grid
        meta.epoch++; // input/resize in flight for the old session must not apply
        if (wasShared) recomputeGrid(); // this member may have been the grid minimum
        send(ws, { t: 'mode', mode: 'lobby', epoch: meta.epoch });
        break;
      }
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
        // kill splits NOW: close() only starts the handshake, and a peer that
        // never completes it keeps the socket alive until ws's ~30s close timeout
        for (const [s, m] of [...sockets]) {
          killSplit(m);
          s.close(4000, 'kicked');
        }
        break;
      // ---- chunked file upload (any mode; the file just lands in /tmp) ----
      // Chunks are base64 in JSON text frames so each stays under the WS
      // maxPayload; the client reassembles nothing — the server does, capping
      // total bytes as they arrive. One upload per socket at a time.
      case 'upload-begin': {
        const size = Number(msg.size);
        if (typeof msg.id !== 'string' || !msg.id) {
          return send(ws, { t: 'upload-error', id: msg.id, msg: 'bad upload id' });
        }
        if (!Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
          return send(ws, { t: 'upload-error', id: msg.id, msg: 'file too large or invalid size' });
        }
        meta.upload = { id: msg.id, name: safeName(msg.name), size, received: 0, chunks: [] };
        break;
      }
      case 'upload-chunk': {
        const u = meta.upload;
        if (!u || u.id !== msg.id || typeof msg.data !== 'string') break; // stale/orphan: drop
        const buf = Buffer.from(msg.data, 'base64');
        u.received += buf.length;
        if (u.received > u.size) {
          meta.upload = null;
          return send(ws, { t: 'upload-error', id: u.id, msg: 'sent more bytes than declared' });
        }
        u.chunks.push(buf);
        break;
      }
      case 'upload-end': {
        const u = meta.upload;
        if (!u || u.id !== msg.id) break;
        meta.upload = null;
        if (u.received !== u.size) {
          return send(ws, { t: 'upload-error', id: u.id, msg: 'incomplete transfer' });
        }
        const dest = path.join(UPLOAD_DIR, randomPrefix() + '-' + u.name);
        if (dest.slice(0, UPLOAD_DIR.length + 1) !== UPLOAD_DIR + '/') { // defense in depth
          return send(ws, { t: 'upload-error', id: u.id, msg: 'refusing to write outside ' + UPLOAD_DIR });
        }
        const data = Buffer.concat(u.chunks, u.received);
        // 0o600: the uploader owns the file; treat it like anything else on a box
        // you have shell access to
        writeFile(dest, data, { mode: 0o600 })
          .then(() => send(ws, { t: 'uploaded', id: u.id, path: dest }))
          .catch((e) => send(ws, { t: 'upload-error', id: u.id, msg: e.message }));
        break;
      }
      case 'hb':
        break; // lastSeen already updated on receipt
      default:
        send(ws, { t: 'error', msg: 'bad message' });
    }
  }

  function onConnection(ws, user) {
    // connections start in the lobby chooser: no replay, no PTY output, no
    // control claim until a shared attach; splits never survive a disconnect
    const meta = {
      username: user.username,
      role: user.role,
      lastSeen: Date.now(),
      mode: 'lobby',
      epoch: 0, // bumped on every session switch; input/resize frames must echo it
      natural: null, // this member's viewport-fitting grid; feeds the shared min-grid
      splitPty: null,
      splitSubs: [],
      upload: null, // in-flight chunked file upload: { id, name, size, received, chunks }
    };
    // No control bookkeeping at connect: control is granted at shared-attach,
    // and a reconnecting controller's stale reservation is preserved only by an
    // actual re-attach (control.reattached in returnToShared) — a socket parked
    // in the lobby must not hold control past the stale timeout. Register
    // before composing hello so stateSnapshot() counts this socket.
    sockets.set(ws, meta);
    send(ws, {
      t: 'hello',
      you: { username: user.username, role: user.role },
      size: session.getSize(),
      state: stateSnapshot(),
      epoch: meta.epoch,
    });
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
      // any close path (disconnect, kickAll, stale terminate) ends the split
      // shell; work inside a tmux started there survives for reattach
      killSplit(meta);
      if (meta.mode === 'shared') recomputeGrid(); // a departed member may have been the minimum
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
