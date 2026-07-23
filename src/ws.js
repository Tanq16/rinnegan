import { WebSocketServer } from 'ws';
import { spawnRawPty } from './pty.js';
import { error } from './log.js';

const STALE_MS = 90000;
const PING_INTERVAL_MS = 25000;
const GRACE_SECONDS = 60;
const MAX_MISSED_REFRESHES = 4;

export function evaluateSocket(meta, nowMs, findUser, accessTtlSeconds) {
  if (nowMs - meta.lastSeen > STALE_MS) return 'terminate';
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec <= meta.deadline + GRACE_SECONDS) return 'ping'; // Infinity deadline (no-auth) always lands here
  const user = findUser(meta.username);
  if (!user) return 'close';
  if (meta.missedRefreshes >= MAX_MISSED_REFRESHES) return 'close';
  meta.deadline += accessTtlSeconds;
  meta.missedRefreshes++;
  meta.role = user.role;
  return 'slide';
}

// A roster read that momentarily fails must never close a possibly-valid session: degrade to a ping.
export function evaluateSocketSafe(meta, nowMs, findUser, accessTtlSeconds) {
  try {
    return evaluateSocket(meta, nowMs, findUser, accessTtlSeconds);
  } catch {
    return 'ping';
  }
}

// The only reset of missedRefreshes: a real client /refresh proves the refresh cookie is still valid.
export function refreshMeta(meta, newExp, newRole) {
  meta.deadline = newExp;
  meta.missedRefreshes = 0;
  if (newRole !== undefined) meta.role = newRole;
}

// A refresh slides only the refreshing user's live sockets forward (never closing an active tab); other users' sessions are untouched.
export function refreshUserSockets(sockets, username, newExp, newRole) {
  for (const meta of sockets.values()) {
    if (meta.username === username) refreshMeta(meta, newExp, newRole);
  }
}

export function attachWebSocket({ config, session, control, authenticate, offerShared, authOn, lookupUser }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1048576 });
  const sockets = new Map();

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

  function broadcastShared(obj) {
    const payload = JSON.stringify(obj);
    for (const [ws, meta] of sockets) {
      if (meta.mode === 'shared' && ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  // Cap the per-socket send queue so a stalled client's backlog cannot exhaust server memory.
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
      session.restart(() => broadcastBinary(Buffer.from('\x1bc'))); // RIS terminal reset between clear and respawn
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

  // tmux-style min-grid: shared PTY tracks the elementwise minimum of attached members' natural grids.
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

  // INVARIANT: kill ONLY the split shell (pty.kill(), never the process group) so a daemonized tmux survives.
  function killSplit(meta) {
    if (!meta.splitPty) return;
    detachSplit(meta).kill();
  }

  // Recomputes the min-grid BEFORE replying so the mode frame carries the post-attach size.
  function returnToShared(ws, meta, cols, rows) {
    meta.natural = clampNatural(cols, rows);
    meta.mode = 'shared';
    meta.epoch++;
    recomputeGrid();
    const buf = session.getBuffer();
    send(ws, { t: 'mode', mode: 'shared', epoch: meta.epoch, ...session.getSize(), bufferBytes: buf.length });
    sendSharedReplay(ws, buf);
    // a reconnecting controller keeps its stale reservation only by re-attaching here, not by connecting
    control.reattached(meta.username);
    if (control.claimIfVacant(meta.username)) broadcastState();
  }

  control.subscribe((kind, data) => {
    if (kind === 'state') broadcastState();
    else if (kind === 'request') sendToUser(control.getState().controller, { t: 'request', from: data.from });
  });

  function handleMessage(ws, meta, raw) {
    if (ws.readyState !== ws.OPEN) return;
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
        // Drop frames tagged with a stale epoch so in-flight input can't execute in a session the user left.
        if (msg.e !== meta.epoch) break;
        if (meta.mode === 'split') {
          if (typeof msg.data === 'string' && meta.splitPty) meta.splitPty.write(msg.data);
          break;
        }
        if (meta.mode === 'lobby') break;
        // non-controller input is silently ignored (spec: no error spam)
        if (control.isController(meta.username) && typeof msg.data === 'string' && session.isRunning()) {
          session.write(msg.data);
        }
        break;
      case 'resize': {
        if (msg.e !== meta.epoch) break;
        if (meta.mode === 'split') {
          const c = clampDim(msg.cols, config.terminal.cols, 20, 500);
          const r = clampDim(msg.rows, config.terminal.rows, 5, 200);
          if (meta.splitPty) meta.splitPty.resize(c, r);
          break;
        }
        if (meta.mode === 'lobby') break;
        meta.natural = clampNatural(msg.cols, msg.rows);
        recomputeGrid();
        break;
      }
      case 'take':
        if (meta.mode !== 'shared') break;
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
        // Release control only after a successful spawn; a failed split must leave control untouched.
        if (control.isController(meta.username)) control.release(meta.username, false);
        control.cancelRequest(meta.username);
        meta.mode = 'split';
        meta.natural = null;
        meta.epoch++;
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
            // shell died on its own: land in the lobby; returning to shared is always an explicit click
            meta.mode = 'lobby';
            meta.epoch++;
            send(ws, { t: 'mode', mode: 'lobby', epoch: meta.epoch });
          }),
        ];
        recomputeGrid();
        send(ws, { t: 'mode', mode: 'split', epoch: meta.epoch, cols, rows });
        break;
      }
      case 'shared':
        if (!offerShared) return send(ws, { t: 'error', msg: 'shared session unavailable' });
        if (meta.mode === 'shared') break;
        killSplit(meta);
        returnToShared(ws, meta, msg.cols, msg.rows);
        break;
      case 'lobby': {
        if (meta.mode === 'lobby') break;
        killSplit(meta);
        if (control.isController(meta.username)) control.release(meta.username, false);
        control.cancelRequest(meta.username);
        const wasShared = meta.mode === 'shared';
        meta.mode = 'lobby';
        meta.natural = null;
        meta.epoch++;
        if (wasShared) recomputeGrid();
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
        if (!offerShared) break;
        if (msg.mode !== 'fast' && msg.mode !== 'soft') return send(ws, { t: 'error', msg: 'invalid mode' });
        control.setMode(msg.mode);
        break;
      case 'restart':
        if (!isAdmin) return send(ws, { t: 'error', msg: 'admin only' });
        // Without a shared tier there is no PTY to restart; doRestart would session.restart() and spawn an orphan.
        if (!offerShared) break;
        doRestart(ws);
        break;
      case 'kickAll':
        if (!isAdmin) return send(ws, { t: 'error', msg: 'admin only' });
        if (!offerShared) break;
        // kill splits NOW: close() only starts the handshake, which a dead peer may never complete
        for (const [s, m] of [...sockets]) {
          killSplit(m);
          s.close(4000, 'kicked');
        }
        break;
      case 'hb':
        break;
      default:
        send(ws, { t: 'error', msg: 'bad message' });
    }
  }

  function onConnection(ws, user) {
    const meta = {
      username: user.username,
      role: user.role,
      lastSeen: Date.now(),
      deadline: typeof user.accessExp === 'number' ? user.accessExp : Infinity,
      missedRefreshes: 0,
      mode: 'lobby',
      epoch: 0,
      natural: null,
      splitPty: null,
      splitSubs: [],
    };
    // No control claim at connect: a lobby-parked socket must not hold control past the stale timeout.
    sockets.set(ws, meta);
    send(ws, {
      t: 'hello',
      you: { username: user.username, role: user.role },
      size: session.getSize(),
      state: stateSnapshot(),
      epoch: meta.epoch,
      offerShared,
      authOn,
      accessExpiresAt: meta.deadline === Infinity ? null : meta.deadline,
    });
    broadcastState();

    ws.on('message', (data, isBinary) => {
      meta.lastSeen = Date.now();
      if (isBinary) return;
      handleMessage(ws, meta, data.toString());
    });
    ws.on('pong', () => {
      meta.lastSeen = Date.now();
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (!sockets.has(ws)) return;
      sockets.delete(ws);
      killSplit(meta);
      if (meta.mode === 'shared') recomputeGrid();
      if (userSocketCount(meta.username) === 0) control.disconnected(meta.username);
      broadcastState();
    });
  }

  // Auth strictly before any protocol activity; bare handshake only carries the close code.
  function handleUpgrade(req, socket, head) {
    const user = authenticate(req);
    if (!user) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'auth required'));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
  }

  const touchUser = (username, newExp, newRole) => refreshUserSockets(sockets, username, newExp, newRole);

  setInterval(() => {
    const now = Date.now();
    const ttl = config.cookie.accessTtlSeconds;
    let roster; // read lazily, at most once per tick: only a past-deadline socket needs it
    let rosterErr; // a failed read is cached too, so lookupUser and its log don't repeat per socket
    const findUser = (username) => {
      if (rosterErr) throw rosterErr;
      if (roster === undefined) {
        try {
          roster = lookupUser();
        } catch (e) {
          rosterErr = e;
          error(`ping sweep roster read failed: ${e.message}`);
          throw e;
        }
      }
      return roster.find((u) => u.username === username) ?? null;
    };
    for (const [ws, meta] of sockets) {
      const action = evaluateSocketSafe(meta, now, findUser, ttl);
      if (action === 'terminate') ws.terminate();
      else if (action === 'close') ws.close(4401, 'session expired');
      else if (action === 'ping') ws.ping();
    }
  }, PING_INTERVAL_MS);

  return { handleUpgrade, touchUser };
}
