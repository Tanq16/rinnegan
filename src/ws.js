import { WebSocketServer } from 'ws';
import { spawnRawPty } from './pty.js';
import { error } from './log.js';

const STALE_MS = 90000;
const PING_INTERVAL_MS = 25000;
const GRACE_SECONDS = 60;
const MAX_MISSED_REFRESHES = 4;
// Cap the per-socket send queue so a stalled client's backlog cannot exhaust server memory.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function evaluateSocket(meta, nowMs, currentFingerprint, accessTtlSeconds) {
  if (nowMs - meta.lastSeen > STALE_MS) return 'terminate';
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec <= meta.deadline + GRACE_SECONDS) return 'ping'; // Infinity (no-auth) never reaches the credential
  if (currentFingerprint() !== meta.fp) return 'close';
  if (meta.missedRefreshes >= MAX_MISSED_REFRESHES) return 'close';
  meta.deadline += accessTtlSeconds;
  meta.missedRefreshes++;
  return 'slide';
}

// A credential read that momentarily fails must never close a possibly-valid session: degrade to a ping.
export function evaluateSocketSafe(meta, nowMs, currentFingerprint, accessTtlSeconds) {
  try {
    return evaluateSocket(meta, nowMs, currentFingerprint, accessTtlSeconds);
  } catch {
    return 'ping';
  }
}

// The only reset of missedRefreshes: a real client /refresh proves the refresh cookie is still valid.
export function refreshMeta(meta, newExp) {
  meta.deadline = newExp;
  meta.missedRefreshes = 0;
}

// One password means one identity, so any successful refresh re-arms every live socket.
export function refreshAllSockets(sockets, newExp) {
  for (const meta of sockets.values()) refreshMeta(meta, newExp);
}

export function attachWebSocket({ config, authenticate, authOn, host, currentFingerprint }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1048576 });
  const sockets = new Map();

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function clampDim(v, fallback, min, max) {
    const n = Number.isInteger(v) ? v : fallback;
    return Math.min(max, Math.max(min, n));
  }

  function detachPty(meta) {
    const p = meta.pty;
    meta.pty = null;
    for (const d of meta.ptySubs) d.dispose();
    meta.ptySubs = [];
    return p;
  }

  // INVARIANT: kill ONLY the shell (pty.kill(), never the process group) so a daemonized tmux survives.
  function killPty(meta) {
    if (!meta.pty) return;
    detachPty(meta).kill();
  }

  function startPty(ws, meta, msg) {
    const cols = clampDim(msg.cols, config.terminal.cols, 20, 500);
    const rows = clampDim(msg.rows, config.terminal.rows, 5, 200);
    meta.running = false;
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
      return send(ws, { t: 'error', msg: e.message });
    }
    meta.epoch++;
    meta.running = true;
    meta.pty = p;
    meta.ptySubs = [
      p.onData((data) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
        else ws.send(Buffer.from(data, 'utf8'), { binary: true });
      }),
      // Identity guard: a restart detaches then respawns, so a killed shell's late exit must not end its successor.
      p.onExit(({ exitCode }) => {
        if (meta.pty !== p) return;
        detachPty(meta);
        meta.running = false;
        meta.epoch++;
        send(ws, { t: 'exited', code: exitCode, epoch: meta.epoch });
      }),
    ];
    send(ws, { t: 'started', epoch: meta.epoch, cols, rows });
  }

  function handleMessage(ws, meta, raw) {
    if (ws.readyState !== ws.OPEN) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { t: 'error', msg: 'bad message' });
    }
    if (!msg || typeof msg.t !== 'string') return send(ws, { t: 'error', msg: 'bad message' });

    switch (msg.t) {
      case 'start':
        // Detach before spawning: the epoch gates client input only, so a dead shell's subscriptions
        // must be disposed synchronously or its exit lands on the replacement.
        killPty(meta);
        startPty(ws, meta, msg);
        break;
      case 'input':
        // Drop frames tagged with a stale epoch so in-flight keystrokes can't execute in a successor shell.
        if (msg.e !== meta.epoch) break;
        if (typeof msg.data === 'string' && meta.pty) meta.pty.write(msg.data);
        break;
      case 'resize':
        if (msg.e !== meta.epoch) break;
        if (meta.pty) {
          meta.pty.resize(
            clampDim(msg.cols, config.terminal.cols, 20, 500),
            clampDim(msg.rows, config.terminal.rows, 5, 200)
          );
        }
        break;
      case 'hb':
        break;
      default:
        send(ws, { t: 'error', msg: 'bad message' });
    }
  }

  function onConnection(ws, session) {
    const meta = {
      fp: session.fp ?? null,
      lastSeen: Date.now(),
      deadline: typeof session.accessExp === 'number' ? session.accessExp : Infinity,
      missedRefreshes: 0,
      running: false,
      epoch: 0,
      pty: null,
      ptySubs: [],
    };
    sockets.set(ws, meta);
    send(ws, {
      t: 'hello',
      epoch: meta.epoch,
      authOn,
      host,
      accessExpiresAt: meta.deadline === Infinity ? null : meta.deadline,
    });

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
      killPty(meta);
    });
  }

  // Auth strictly before any protocol activity; bare handshake only carries the close code.
  function handleUpgrade(req, socket, head) {
    const session = authenticate(req);
    if (!session) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'auth required'));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session));
  }

  setInterval(() => {
    const now = Date.now();
    const ttl = config.cookie.accessTtlSeconds;
    let fp; // read lazily, at most once per tick: only a past-deadline socket needs it
    let fpErr;
    const current = () => {
      if (fpErr) throw fpErr;
      if (fp === undefined) {
        try {
          fp = currentFingerprint();
        } catch (e) {
          fpErr = e;
          error(`ping sweep credential read failed: ${e.message}`);
          throw e;
        }
      }
      return fp;
    };
    for (const [ws, meta] of sockets) {
      const action = evaluateSocketSafe(meta, now, current, ttl);
      if (action === 'terminate') ws.terminate();
      else if (action === 'close') ws.close(4401, 'session expired');
      else if (action === 'ping') ws.ping();
    }
  }, PING_INTERVAL_MS);

  return { handleUpgrade, touchAll: (newExp) => refreshAllSockets(sockets, newExp) };
}
