#!/usr/bin/env node
// End-to-end test for rinnegan. Run: node test/e2e.mjs (exit 0 = all checks pass, 1 = failure).
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { hashPassword } from '../src/auth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin', 'rinnegan.js');
const PORT = 0; // 0 = OS-assigned; the real port is parsed from the server's "listening" line
const ADMIN_PASS = 'e2e-admin-password';
const USER_PASS = 'e2e-user-password';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let checksPassed = 0;
async function check(name, fn) {
  try {
    await fn();
    checksPassed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.log(`FAIL - ${name}: ${e && e.message}`);
    throw e;
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout (${ms}ms) waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class WSClient {
  constructor(url, cookie) {
    this.ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
    this.texts = [];
    this.cursor = 0; // waitText consumes forward-only
    this.bin = [];
    this.binBytes = 0;
    this.epoch = null; // session epoch from hello/mode; echoed as `e` in input/resize
    this.closed = null;
    this.waiters = new Set();
    this.ws.on('open', () => this.#notify());
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const b = Buffer.from(data);
        this.bin.push(b);
        this.binBytes += b.length;
      } else {
        try {
          const m = JSON.parse(data.toString());
          this.texts.push(m);
          if (m.t === 'hello' || m.t === 'mode') this.epoch = m.epoch;
        } catch { /* ignore unparsable */ }
      }
      this.#notify();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason ? reason.toString() : '' };
      this.#notify();
    });
    this.ws.on('error', () => {}); // 'close' always follows; waiters observe this.closed
  }

  #notify() { for (const w of [...this.waiters]) w(); }

  // checkFn returns undefined = keep waiting, throws = fail, anything else = resolve
  #wait(checkFn, ms, what) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => { done = true; clearTimeout(timer); this.waiters.delete(attempt); };
      const timer = setTimeout(() => {
        if (done) return;
        finish();
        reject(new Error(`timeout (${ms}ms) waiting for ${what}`));
      }, ms);
      const attempt = () => {
        if (done) return;
        let r;
        try { r = checkFn(); } catch (e) { finish(); reject(e); return; }
        if (r !== undefined) { finish(); resolve(r); }
      };
      this.waiters.add(attempt);
      attempt();
    });
  }

  waitOpen(ms = 5000) {
    return this.#wait(() => {
      if (this.closed) throw new Error(`socket closed (code ${this.closed.code}) before open`);
      return this.ws.readyState === WebSocket.OPEN ? true : undefined;
    }, ms, 'ws open');
  }

  waitText(pred, ms, what) {
    return this.#wait(() => {
      for (let i = this.cursor; i < this.texts.length; i++) {
        if (pred(this.texts[i])) { this.cursor = i + 1; return this.texts[i]; }
      }
      if (this.closed) throw new Error(`socket closed (code ${this.closed.code}) while waiting for ${what}`);
      return undefined;
    }, ms, what);
  }

  // like waitText but scans the whole history without consuming (order not part of the contract)
  waitTextAnywhere(pred, ms, what) {
    return this.#wait(() => {
      for (const m of this.texts) if (pred(m)) return m;
      if (this.closed) throw new Error(`socket closed (code ${this.closed.code}) while waiting for ${what}`);
      return undefined;
    }, ms, what);
  }

  nextText(ms, what) { return this.waitText(() => true, ms, what); }

  // fast-forward past every already-received text so waitText only sees new ones
  skipTexts() { this.cursor = this.texts.length; }

  waitBinContains(needle, fromByte, ms, what) {
    return this.#wait(() => {
      if (Buffer.concat(this.bin).indexOf(needle, fromByte) !== -1) return true;
      if (this.closed) throw new Error(`socket closed (code ${this.closed.code}) while waiting for ${what}`);
      return undefined;
    }, ms, what);
  }

  // matches the shared-buffer replay frame by exact `bytes` length, ignoring stray split-pty frames in flight
  waitReplayFrame(fromIndex, bytes, ms, what) {
    return this.#wait(() => {
      for (let i = fromIndex; i < this.bin.length; i++) {
        if (this.bin[i].length === bytes) return this.bin[i];
      }
      if (this.closed) throw new Error(`socket closed (code ${this.closed.code}) while waiting for ${what}`);
      return undefined;
    }, ms, what);
  }

  // attach to shared: reply cols/rows carry the recomputed min-grid; `replay` is set when bufferBytes > 0
  async attachShared(cols, rows, ms = 8000) {
    const fromIdx = this.bin.length;
    const beforeTexts = this.texts.length;
    this.send({ t: 'shared', cols, rows });
    const m = await this.waitText((x) => x.t === 'mode' && x.mode === 'shared', ms, 'mode shared reply');
    assert.ok(Number.isInteger(m.cols) && Number.isInteger(m.rows), 'mode shared must carry cols/rows');
    assert.ok(Number.isInteger(m.bufferBytes) && m.bufferBytes >= 0, 'mode shared must carry bufferBytes');
    for (const t of this.texts.slice(beforeTexts)) {
      if (t.t === 'mode' && t.mode === 'lobby') throw new Error('unexpected lobby hop while attaching to shared');
    }
    if (m.bufferBytes > 0) {
      m.replay = await this.waitReplayFrame(fromIdx, m.bufferBytes, ms, 'shared buffer replay frame');
    }
    return m;
  }

  waitClose(ms, what) {
    return this.#wait(() => this.closed ?? undefined, ms, what);
  }

  binAll() { return Buffer.concat(this.bin); }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  terminate() { try { this.ws.terminate(); } catch { /* already dead */ } }
}

function startServer(configPath) {
  const child = spawn(process.execPath, [BIN, 'serve', '--config', configPath], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const ready = withTimeout(new Promise((resolve, reject) => {
    const scan = () => {
      const m = stdout.match(/listening on http:\/\/([^\s:]+):(\d+)/);
      if (m) resolve({ host: m[1], port: Number(m[2]) });
    };
    child.stdout.on('data', scan);
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code})\n--- server stderr ---\n${stderr}`)));
    scan();
  }), 15000, 'server "listening" line');
  return { child, ready, getStderr: () => stderr };
}

// exit code of a local command, or null if it could not be spawned (not on PATH)
function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', () => resolve(null));
    p.on('exit', (code) => resolve(code));
  });
}

function getCookiePair(res, name) {
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith(name + '=')) return sc;
  }
  return null;
}

function assertHelloShape(msg, username, role) {
  assert.equal(msg.t, 'hello', `first message must be hello, got ${JSON.stringify(msg)}`);
  assert.ok(msg.you && msg.size && msg.state, 'hello missing you/size/state');
  assert.equal(msg.you.username, username);
  assert.equal(msg.you.role, role);
  assert.ok(Number.isInteger(msg.size.cols) && Number.isInteger(msg.size.rows), 'hello.size cols/rows must be integers');
  for (const k of ['controller', 'mode', 'viewers', 'pending']) {
    assert.ok(k in msg.state, `hello.state missing ${k}`);
  }
  // buffer is delivered only on shared attach, so hello must carry no bufferBytes
  assert.ok(!('bufferBytes' in msg), 'hello must not carry bufferBytes');
  assert.ok(Number.isInteger(msg.epoch), 'hello.epoch must be an integer');
}

async function main() {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webterm-e2e-'));
  let server = null;
  const clients = [];
  const uploadedPaths = []; // /tmp files, batch roots and dirs created by transfer checks; removed in finally
  const track = (c) => { clients.push(c); return c; };

  try {
    await fs.promises.writeFile(path.join(tmp, 'users.json'), JSON.stringify({
      users: [
        { username: 'tanish', role: 'admin', password: await hashPassword(ADMIN_PASS) },
        { username: 'engineer-a', role: 'user', password: await hashPassword(USER_PASS) },
      ],
    }, null, 2) + '\n', { mode: 0o600 });

    await fs.promises.writeFile(path.join(tmp, 'config.json'), JSON.stringify({
      listen: { host: '127.0.0.1', port: PORT },
      cookie: { secure: false, name: 'rinnegan', ttlSeconds: 3600 },
      terminal: { shell: '/usr/bin/env sh -l', cwd: tmp, cols: 120, rows: 36, autoRestartShell: false },
      control: { mode: 'soft', staleControllerSeconds: 5, requestTimeoutSeconds: 30 },
      buffer: { maxBytes: 65536 },
      usersFile: './users.json',
      stateFile: './state.json',
    }, null, 2) + '\n');

    server = startServer(path.join(tmp, 'config.json'));
    const { port } = await server.ready;
    const base = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const get = (p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const post = (p, fields, cookie) => fetch(base + p, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams(fields ?? {}),
      headers: cookie ? { cookie } : {},
    });

    await check('GET / unauthenticated redirects to /login', async () => {
      const res = await get('/');
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login');
    });

    await check('GET /login serves html', async () => {
      const res = await get('/login');
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').includes('text/html'));
    });

    await check('POST /login wrong password redirects with error', async () => {
      const res = await post('/login', { username: 'tanish', password: 'wrong-password' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login?error=1');
      assert.equal(getCookiePair(res, 'rinnegan'), null, 'must not set session cookie on bad login');
    });

    let cookieAdmin;
    await check('POST /login correct sets HttpOnly cookie and redirects to /', async () => {
      const res = await post('/login', { username: 'tanish', password: ADMIN_PASS });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      const sc = getCookiePair(res, 'rinnegan');
      assert.ok(sc, 'missing Set-Cookie for rinnegan');
      assert.ok(/httponly/i.test(sc), 'cookie must be HttpOnly');
      cookieAdmin = sc.split(';')[0];
      assert.ok(cookieAdmin.length > 'rinnegan='.length, 'cookie value empty');
    });

    await check('GET / with cookie serves terminal page', async () => {
      const res = await get('/', cookieAdmin);
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').includes('text/html'));
    });

    await check('GET /styles.css and /app.js serve statics', async () => {
      const css = await get('/styles.css');
      assert.equal(css.status, 200);
      assert.ok((css.headers.get('content-type') || '').includes('text/css'));
      const js = await get('/app.js');
      assert.equal(js.status, 200);
      assert.ok((js.headers.get('content-type') || '').includes('text/javascript'));
    });

    await check('statics send cache validators; If-None-Match returns 304', async () => {
      const js = await get('/app.js');
      assert.equal(js.headers.get('cache-control'), 'no-cache', 'app.js must be no-cache');
      const etag = js.headers.get('etag');
      assert.ok(etag, 'app.js missing ETag');
      const again = await fetch(base + '/app.js', { headers: { 'if-none-match': etag } });
      assert.equal(again.status, 304, 'matching If-None-Match must 304');
      const vend = await get('/vendor/xterm.js');
      assert.equal(vend.status, 200);
      assert.equal(vend.headers.get('cache-control'), 'public, max-age=86400', 'vendor assets must be cacheable');
      assert.ok(vend.headers.get('etag'), 'vendor asset missing ETag');
    });

    let cookieUser;
    await check('POST /login as engineer-a succeeds', async () => {
      const res = await post('/login', { username: 'engineer-a', password: USER_PASS });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      const sc = getCookiePair(res, 'rinnegan');
      assert.ok(sc, 'missing Set-Cookie for engineer-a');
      cookieUser = sc.split(';')[0];
    });

    await check('WS upgrade without cookie rejected (4401)', async () => {
      const c = track(new WSClient(wsUrl, null));
      const closed = await c.waitClose(5000, 'unauthenticated ws close');
      // WS auth must reject before accepting the socket: handshake completes only to deliver 4401 (1006 = raw HTTP reject)
      assert.ok(closed.code === 4401 || closed.code === 1006, `expected 4401 (or 1006), got ${closed.code}`);
    });

    const admin = track(new WSClient(wsUrl, cookieAdmin));
    let adminHello;
    await check('WS with cookie: hello carries you/size/state/epoch, no replay', async () => {
      adminHello = await admin.nextText(5000, 'admin hello');
      assertHelloShape(adminHello, 'tanish', 'admin');
      // connecting grants nothing; control is assigned only on attach
      assert.equal(adminHello.state.controller, null, 'connecting must not auto-grant control');
    });

    const eng = track(new WSClient(wsUrl, cookieUser));
    let engHello;
    await check('second client hello shows viewers=2', async () => {
      engHello = await eng.nextText(5000, 'engineer-a hello');
      assertHelloShape(engHello, 'engineer-a', 'user');
      assert.equal(engHello.state.viewers, 2);
    });

    await check('lobby is silent: no output; input/resize/control dropped', async () => {
      // quote-split so the marker only materializes if lobby input wrongly reaches a shell
      eng.send({ t: 'input', data: "echo E2E_LOBBY_DR''OP\r", e: eng.epoch });
      eng.send({ t: 'resize', cols: 50, rows: 10, e: eng.epoch });
      eng.send({ t: 'take' });
      eng.send({ t: 'request' });
      await sleep(1000);
      assert.equal(admin.bin.length, 0, 'binary output reached a lobby connection (tanish)');
      assert.equal(eng.bin.length, 0, 'binary output reached a lobby connection (engineer-a)');
      for (const c of [admin, eng]) {
        assert.ok(!c.texts.some((m) => m.t === 'size' || m.t === 'ended'), 'size/ended frame reached a lobby connection');
        assert.ok(!c.texts.some((m) => m.t === 'state' && m.controller === 'engineer-a'), 'lobby take/request acquired control');
      }
    });

    await check('first shared attach: mode+replay reply, auto-granted control', async () => {
      const m = await admin.attachShared(120, 36);
      assert.equal(m.cols, 120, 'sole attacher must get its own natural grid');
      assert.equal(m.rows, 36);
      assert.ok(m.epoch > adminHello.epoch, 'attach must bump the session epoch');
      await admin.waitTextAnywhere((x) => x.t === 'state' && x.controller === 'tanish', 5000, 'auto-grant to first attacher');
    });

    await check('controller input executes in shell (binary output contains marker)', async () => {
      // quote-split so the marker only appears once the shell actually runs the command
      admin.send({ t: 'input', data: "echo E2E_MAR''KER_1\r", e: admin.epoch });
      await admin.waitBinContains('E2E_MARKER_1', 0, 8000, 'E2E_MARKER_1 in pty output');
      // had lobby input reached the pty, its output would precede this marker in the replay
      assert.ok(!admin.binAll().includes('E2E_LOBBY_DROP'), 'lobby input reached the shared pty');
    });

    await check('input with a stale session epoch is dropped', async () => {
      // the sender IS the controller, so a drop can only be the epoch gate
      admin.send({ t: 'input', data: "echo E2E_STALE_EP''OCH\r", e: admin.epoch + 1 });
      admin.send({ t: 'input', data: "echo E2E_STALE_EP''OCH\r" });
      admin.send({ t: 'input', data: "echo E2E_STALE_EP''OCH\r", e: adminHello.epoch }); // pre-attach (lobby) epoch
      await sleep(1500);
      assert.ok(!admin.binAll().includes('E2E_STALE_EPOCH'), 'stale-epoch input reached the shared pty');
    });

    await check('min-grid: a smaller attacher shrinks the shared grid for everyone', async () => {
      const m = await eng.attachShared(90, 25);
      assert.equal(m.cols, 90, 'mode reply must carry the recomputed min-grid cols');
      assert.equal(m.rows, 25, 'mode reply must carry the recomputed min-grid rows');
      await admin.waitText((x) => x.t === 'size' && x.cols === 90 && x.rows === 25, 5000, 'admin size 90x25');
    });

    await check('non-controller input is ignored', async () => {
      eng.send({ t: 'input', data: 'echo E2E_IGNORED_MARK\r', e: eng.epoch });
      await sleep(1500);
      assert.ok(!admin.binAll().includes('E2E_IGNORED_MARK'), 'non-controller input leaked to pty (seen by admin)');
      assert.ok(!eng.binAll().includes('E2E_IGNORED_MARK'), 'non-controller input leaked to pty (seen by engineer-a)');
    });

    await check('request relayed to controller', async () => {
      eng.send({ t: 'request' });
      const req = await admin.waitText((m) => m.t === 'request', 5000, 'request relay to controller');
      assert.equal(req.from, 'engineer-a');
    });

    await check('grant transfers control to engineer-a', async () => {
      admin.send({ t: 'grant', to: 'engineer-a' });
      const [a, b] = await Promise.all([
        admin.waitText((m) => m.t === 'state' && m.controller === 'engineer-a', 5000, 'admin state controller=engineer-a'),
        eng.waitText((m) => m.t === 'state' && m.controller === 'engineer-a', 5000, 'engineer-a state controller=engineer-a'),
      ]);
      assert.equal(a.pending, null);
      assert.equal(b.pending, null);
    });

    await check('release sets controller to null', async () => {
      eng.send({ t: 'release' });
      await Promise.all([
        admin.waitText((m) => m.t === 'state' && m.controller === null, 5000, 'admin state controller=null'),
        eng.waitText((m) => m.t === 'state' && m.controller === null, 5000, 'engineer-a state controller=null'),
      ]);
    });

    await check('min-grid: member re-report recomputes the grid without control', async () => {
      // controller is null here: resize is a natural-size report from any member, not a control privilege
      eng.send({ t: 'resize', cols: 100, rows: 30, e: eng.epoch });
      await Promise.all([
        admin.waitText((m) => m.t === 'size' && m.cols === 100 && m.rows === 30, 5000, 'admin size 100x30'),
        eng.waitText((m) => m.t === 'size' && m.cols === 100 && m.rows === 30, 5000, 'engineer-a size 100x30'),
      ]);
    });

    await check('min-grid: member disconnect restores the larger grid', async () => {
      const mgc = track(new WSClient(wsUrl, cookieUser));
      assertHelloShape(await mgc.nextText(5000, 'min-grid socket hello'), 'engineer-a', 'user');
      const m = await mgc.attachShared(80, 20);
      assert.equal(m.cols, 80);
      assert.equal(m.rows, 20);
      await admin.waitText((x) => x.t === 'size' && x.cols === 80 && x.rows === 20, 5000, 'admin size 80x20');
      mgc.terminate();
      // min over the remaining members: tanish 120x36, engineer-a 100x30
      await admin.waitText((x) => x.t === 'size' && x.cols === 100 && x.rows === 30, 5000, 'admin size 100x30 after detach');
    });

    await check('admin restart sends RIS and terminal keeps working', async () => {
      const off = admin.binBytes;
      admin.send({ t: 'restart' });
      await admin.waitBinContains('\x1bc', off, 8000, 'RIS (\\x1bc) after restart');
      await admin.waitText((m) => m.t === 'size', 5000, 'size broadcast after restart');
      admin.send({ t: 'take' });
      await admin.waitText((m) => m.t === 'state' && m.controller === 'tanish', 5000, 'controller=tanish after restart');
      admin.send({ t: 'input', data: "echo E2E_AFTER_RE''START\r", e: admin.epoch });
      await admin.waitBinContains('E2E_AFTER_RESTART', off, 8000, 'E2E_AFTER_RESTART after restart');
    });

    await check('kickAll closes all sockets with 4000', async () => {
      admin.send({ t: 'kickAll' });
      const [ca, cb] = await Promise.all([
        admin.waitClose(5000, 'admin close after kickAll'),
        eng.waitClose(5000, 'engineer-a close after kickAll'),
      ]);
      assert.equal(ca.code, 4000, `admin close code ${ca.code}`);
      assert.equal(cb.code, 4000, `engineer-a close code ${cb.code}`);
    });

    await check('attach clamps the natural grid to 20..500 cols and 5..200 rows', async () => {
      const cc = track(new WSClient(wsUrl, cookieAdmin));
      assertHelloShape(await cc.nextText(5000, 'clamp attach hello'), 'tanish', 'admin');
      const m = await cc.attachShared(9999, 1); // sole member: the min IS the clamp
      assert.equal(m.cols, 500);
      assert.equal(m.rows, 5);
      cc.ws.close();
      await cc.waitClose(5000, 'clamp socket close'); // fully detach before the next attach recomputes
    });

    await check('reconnect lands in the lobby; attaching replays the buffer', async () => {
      const c2 = track(new WSClient(wsUrl, cookieAdmin));
      const hello = await c2.nextText(5000, 'reconnect hello');
      assertHelloShape(hello, 'tanish', 'admin');
      assert.equal(hello.state.controller, 'tanish', 'stale-controller reservation must survive the kick');
      const m = await c2.attachShared(100, 30);
      assert.equal(m.cols, 100, 'sole attacher must reset the grid held at 500x5');
      assert.equal(m.rows, 30);
      assert.ok(m.bufferBytes > 0, `expected bufferBytes > 0, got ${m.bufferBytes}`);
      assert.ok(m.replay.includes('E2E_AFTER_RESTART'), 'replayed buffer missing prior output');
      c2.skipTexts();
      c2.send({ t: 'release' }); // leave control vacant for the split section below
      await c2.waitText((x) => x.t === 'state' && x.controller === null, 5000, 'controller vacated');
      c2.ws.close();
      await c2.waitClose(5000, 'reconnect socket close');
    });

    await check('POST /logout clears the cookie', async () => {
      const res = await post('/logout', {}, cookieAdmin);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login');
      const sc = getCookiePair(res, 'rinnegan');
      assert.ok(sc, 'logout missing Set-Cookie');
      assert.ok(/max-age=0/i.test(sc), 'logout cookie must have Max-Age=0');
      assert.equal(sc.split(';')[0], 'rinnegan=', 'logout cookie value must be empty');
    });

    // logout only clears the browser cookie (no revocation list), so these earlier cookies remain valid
    const sa = track(new WSClient(wsUrl, cookieAdmin)); // toggles split/shared/lobby
    const sb = track(new WSClient(wsUrl, cookieUser)); // stays shared: must never see split output
    const rand = Math.random().toString(36).slice(2, 10);

    await check('split works directly from the lobby (mode reply echoes size)', async () => {
      const saHello = await sa.nextText(5000, 'split admin hello');
      assertHelloShape(saHello, 'tanish', 'admin');
      assert.equal(saHello.state.controller, null, 'control must be vacant after the release above');
      assertHelloShape(await sb.nextText(5000, 'split viewer hello'), 'engineer-a', 'user');
      sa.send({ t: 'split', cols: 100, rows: 30 }); // never attached to shared
      const m = await sa.waitText((x) => x.t === 'mode', 8000, 'mode reply after split');
      assert.equal(m.mode, 'split');
      assert.equal(m.cols, 100);
      assert.equal(m.rows, 30);
    });

    await check('split size is clamped to 20..500 cols and 5..200 rows', async () => {
      const sc = track(new WSClient(wsUrl, cookieUser));
      assertHelloShape(await sc.nextText(5000, 'clamp socket hello'), 'engineer-a', 'user');
      sc.send({ t: 'split', cols: 9999, rows: 1 });
      const m = await sc.waitText((x) => x.t === 'mode', 8000, 'clamped mode reply');
      assert.equal(m.mode, 'split');
      assert.equal(m.cols, 500);
      assert.equal(m.rows, 5);
      sc.ws.close(); // disconnect must kill this split pty server-side
    });

    await check('attaching to shared auto-grants vacant control', async () => {
      const m = await sb.attachShared(100, 30);
      assert.equal(m.cols, 100);
      assert.equal(m.rows, 30);
      await sb.waitTextAnywhere((x) => x.t === 'state' && x.controller === 'engineer-a', 5000, 'auto-grant on attach');
    });

    await check('split output is isolated from shared viewers', async () => {
      // quote-split so the marker only appears once the split shell runs it
      sa.send({ t: 'input', data: `echo SPLIT_MAR''KER_${rand}\r`, e: sa.epoch });
      await sa.waitBinContains(`SPLIT_MARKER_${rand}`, 0, 10000, 'split marker in own output');
      await sleep(1500); // window for any (wrongly broadcast) output to reach the viewer
      assert.ok(!sb.binAll().includes(`SPLIT_MARKER_${rand}`), 'split output leaked to a shared viewer');
    });

    await check('split input needs no control', async () => {
      // sa never attached to shared, so the latest control broadcast must not name it
      const lastState = sa.texts.filter((m) => m.t === 'state').pop();
      assert.ok(lastState, 'expected at least one control-state broadcast on the split socket');
      assert.notEqual(lastState.controller, 'tanish', 'split socket must not hold shared control');
      const off = sa.binBytes;
      sa.send({ t: 'input', data: `echo SPLIT_NOC''TRL_${rand}\r`, e: sa.epoch });
      await sa.waitBinContains(`SPLIT_NOCTRL_${rand}`, off, 10000, 'non-controller split input output');
    });

    await check('shared output is isolated from split sockets', async () => {
      // sb drives the shared shell; none of its output may reach the split socket
      sb.send({ t: 'input', data: `echo SHARED_MAR''KER_${rand}\r`, e: sb.epoch });
      await sb.waitBinContains(`SHARED_MARKER_${rand}`, 0, 10000, 'shared marker on the shared socket');
      await sleep(1500); // window for any (wrongly broadcast) shared output to reach sa
      assert.ok(!sa.binAll().includes(`SHARED_MARKER_${rand}`), 'shared output leaked to a split socket');
      sb.skipTexts();
      sb.send({ t: 'release' });
      await sb.waitText((m) => m.t === 'state' && m.controller === null, 5000, 'sb releases control');
    });

    await check('splitting as controller releases control (broadcast to viewers)', async () => {
      // assert the auto-grant without consuming (racing skipTexts against the coalesced grant frame is flaky)
      await sa.attachShared(100, 30); // back to shared: vacant control auto-grants to sa
      await Promise.all([
        sa.waitTextAnywhere((m) => m.t === 'state' && m.controller === 'tanish', 5000, 'sa sees controller=tanish'),
        sb.waitTextAnywhere((m) => m.t === 'state' && m.controller === 'tanish', 5000, 'sb sees controller=tanish'),
      ]);
      sb.skipTexts();
      sa.send({ t: 'split', cols: 100, rows: 30 });
      await sb.waitText((m) => m.t === 'state' && m.controller === null, 5000, 'release broadcast to shared viewer');
      const m = await sa.waitText((x) => x.t === 'mode', 8000, 'mode reply after controller split');
      assert.equal(m.mode, 'split');
    });

    await check('explicit return from split goes straight to shared with replay', async () => {
      // attachShared fails on any lobby hop: the intentional button skips the chooser
      const m = await sa.attachShared(100, 30);
      assert.ok(m.bufferBytes > 0, `expected bufferBytes > 0, got ${m.bufferBytes}`);
      assert.ok(m.replay.includes('E2E_AFTER_RESTART'), 'replayed buffer missing prior shared output');
    });

    await check('split owner resizes own pty without control', async () => {
      sa.send({ t: 'split', cols: 100, rows: 30 });
      await sa.waitText((x) => x.t === 'mode' && x.mode === 'split', 8000, 'mode split before resize');
      sa.send({ t: 'resize', cols: 90, rows: 25, e: sa.epoch });
      await sleep(300); // let the resize land before querying
      const off = sa.binBytes;
      sa.send({ t: 'input', data: 'stty size\r', e: sa.epoch });
      await sa.waitBinContains('25 90', off, 10000, '"25 90" from stty size');
    });

    await check('split shell exit sends splitExited then lands in the lobby', async () => {
      const splitEpoch = sa.epoch;
      // stale-epoch input on a split socket must be dropped, not run anywhere
      sa.send({ t: 'input', data: `echo STALE_SP''LIT_${rand}\r`, e: sa.epoch - 1 });
      sa.send({ t: 'input', data: 'exit\r', e: sa.epoch });
      const exited = await sa.waitText((m) => m.t === 'splitExited', 10000, 'splitExited');
      assert.ok('code' in exited, 'splitExited missing exit code');
      const m = await sa.waitText((x) => x.t === 'mode', 8000, 'mode after splitExited');
      assert.equal(m.mode, 'lobby', 'split exit must land in the lobby, not shared');
      assert.ok(Number.isInteger(m.epoch) && m.epoch > splitEpoch, 'lobby mode frame must carry a bumped epoch');
      assert.ok(!('bufferBytes' in m) && !('cols' in m), 'lobby mode frame must carry epoch only');
      const binCount = sa.bin.length;
      const textCount = sa.texts.length;
      await sleep(800);
      assert.equal(sa.bin.length, binCount, 'no replay may follow the drop to the lobby');
      assert.ok(!sa.texts.slice(textCount).some((x) => x.t === 'mode'), 'no auto mode switch may follow the drop to the lobby');
      assert.ok(!sa.binAll().includes(`STALE_SPLIT_${rand}`), 'stale-epoch input executed in the split');
      assert.ok(!sb.binAll().includes(`STALE_SPLIT_${rand}`), 'stale-epoch split input crossed into the shared pty');
    });

    await check('attaching from the post-exit lobby delivers the shared replay', async () => {
      const m = await sa.attachShared(100, 30);
      assert.ok(m.bufferBytes > 0, `expected bufferBytes > 0, got ${m.bufferBytes}`);
      assert.ok(m.replay.includes('E2E_AFTER_RESTART'), 'replayed buffer missing prior shared output');
    });

    await check('disconnect kills the split shell process', async () => {
      const sd = track(new WSClient(wsUrl, cookieAdmin));
      assertHelloShape(await sd.nextText(5000, 'disconnect socket hello'), 'tanish', 'admin');
      sd.send({ t: 'split', cols: 100, rows: 30 });
      await sd.waitText((m) => m.t === 'mode' && m.mode === 'split', 8000, 'mode split before disconnect');
      // $$ expands only when the shell runs it; the typed echo has no digits there
      sd.send({ t: 'input', data: 'echo "PID:$$:DIP"\r', e: sd.epoch });
      let pid = null;
      const parseEnd = Date.now() + 10000;
      while (Date.now() < parseEnd) {
        const m = sd.binAll().toString('utf8').match(/PID:(\d+):DIP/);
        if (m) { pid = Number(m[1]); break; }
        await sleep(100);
      }
      assert.ok(Number.isInteger(pid) && pid > 1, `could not parse split shell pid (got ${pid})`);
      process.kill(pid, 0); // must be alive before the disconnect
      sd.terminate();
      let gone = false;
      const killEnd = Date.now() + 6000;
      while (Date.now() < killEnd) {
        try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { gone = true; } break; }
        await sleep(200);
      }
      assert.ok(gone, `split shell pid ${pid} still alive after disconnect`);
    });

    await check('tmux server survives split shell death (skipped without tmux)', async () => {
      if (await runCmd('tmux', ['-V']) !== 0) {
        console.log('# note: tmux not on PATH — skipping tmux survival check');
        return;
      }
      const sess = `webterm-e2e-${process.pid}`;
      const se = track(new WSClient(wsUrl, cookieAdmin));
      assertHelloShape(await se.nextText(5000, 'tmux socket hello'), 'tanish', 'admin');
      se.send({ t: 'split', cols: 100, rows: 30 });
      await se.waitText((m) => m.t === 'mode' && m.mode === 'split', 8000, 'mode split for tmux check');
      const off = se.binBytes;
      se.send({ t: 'input', data: `tmux new-session -d -s ${sess} && echo TMUX_'U'P_OK || echo TMUX_'U'P_FAIL\r`, e: se.epoch });
      let started = null;
      const tmuxEnd = Date.now() + 15000;
      while (Date.now() < tmuxEnd) {
        const out = se.binAll().slice(off).toString('utf8');
        if (out.includes('TMUX_UP_OK')) { started = true; break; }
        if (out.includes('TMUX_UP_FAIL')) { started = false; break; }
        await sleep(100);
      }
      if (started === false) {
        console.log('# note: tmux unusable inside the split shell — skipping tmux survival check');
        se.ws.close();
        return;
      }
      assert.ok(started, 'timed out waiting for tmux new-session inside the split');
      try {
        await se.attachShared(100, 30); // kills the split pty immediately
        await sleep(500); // give the split shell time to die
        assert.equal(await runCmd('tmux', ['has-session', '-t', sess]), 0,
          'tmux session must survive the split shell being killed');
      } finally {
        await runCmd('tmux', ['kill-session', '-t', sess]); // clean up ONLY our session
        se.ws.close();
      }
    });

    const uploadBody = Buffer.from('E2E_UPLOAD_BODY_' + rand + '\n');
    let uploadedFile;

    await check('POST /upload streams a file to /tmp with a 5-char random prefix', async () => {
      const res = await fetch(base + '/upload?name=e2e-upload.txt', {
        method: 'POST',
        headers: { cookie: cookieAdmin },
        body: uploadBody,
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      uploadedPaths.push(json.path);
      uploadedFile = json.path;
      assert.match(json.path, /^\/tmp\/[a-z0-9]{5}-e2e-upload\.txt$/, `unexpected path ${json.path}`);
      assert.equal(fs.readFileSync(json.path, 'utf8'), uploadBody.toString(), 'uploaded bytes differ from source');
      assert.equal(fs.statSync(json.path).mode & 0o777, 0o600, 'uploaded file must be mode 0600');
    });

    await check('upload sanitizes a hostile filename', async () => {
      const nasty = '../../etc/e2e nasty;$(rm -rf).txt'; // traversal + spaces + shell metachars
      const body = Buffer.from('SANITIZE_BODY_' + rand);
      const send = () => fetch(base + '/upload?name=' + encodeURIComponent(nasty), {
        method: 'POST',
        headers: { cookie: cookieUser },
        body,
      });
      const a = await (await send()).json();
      uploadedPaths.push(a.path);
      assert.match(a.path, /^\/tmp\/[a-z0-9]{5}-[A-Za-z0-9._-]+\.txt$/, `unsanitized path ${a.path}`);
      assert.ok(!a.path.includes('..'), 'traversal survived sanitization');
      assert.ok(!a.path.slice('/tmp/'.length).includes('/'), 'path escaped /tmp');
      assert.ok(!/[;$()\s]/.test(a.path), 'shell metacharacters survived sanitization');
      assert.equal(fs.readFileSync(a.path, 'utf8'), body.toString(), 'uploaded bytes differ from source');
      // same name again → a different random prefix, a different file
      const b = await (await send()).json();
      uploadedPaths.push(b.path);
      assert.notEqual(a.path, b.path, 'identical names must get distinct random prefixes');
    });

    await check('unauthenticated transfer routes are refused', async () => {
      const up = await fetch(base + '/upload?name=x', { method: 'POST', body: 'nope' });
      assert.equal(up.status, 401);
      const dl = await fetch(base + '/download?path=/etc/hostname');
      assert.equal(dl.status, 401);
    });

    await check('GET /download round-trips an uploaded file', async () => {
      const head = await fetch(base + '/download?path=' + encodeURIComponent(uploadedFile), {
        method: 'HEAD',
        headers: { cookie: cookieUser },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(uploadBody.length));
      assert.ok((head.headers.get('content-disposition') || '').includes('attachment'),
        'download must be sent as an attachment');
      const res = await fetch(base + '/download?path=' + encodeURIComponent(uploadedFile), {
        headers: { cookie: cookieUser },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), uploadBody, 'downloaded bytes differ from source');
    });

    await check('download probe rejects bad paths', async () => {
      const missing = await fetch(base + '/download?path=/tmp/e2e-missing-' + rand, {
        method: 'HEAD',
        headers: { cookie: cookieAdmin },
      });
      assert.equal(missing.status, 404);
      const rel = await fetch(base + '/download?path=relative', { headers: { cookie: cookieAdmin } });
      assert.equal(rel.status, 400);
    });

    await check('directory download arrives as tar.gz', async () => {
      const dir = '/tmp/e2e-dl-' + rand;
      fs.mkdirSync(dir, { recursive: true });
      uploadedPaths.push(dir);
      fs.writeFileSync(path.join(dir, 'inside.txt'), 'DIR_BODY_' + rand + '\n');
      const res = await fetch(base + '/download?path=' + encodeURIComponent(dir), {
        headers: { cookie: cookieAdmin },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/gzip');
      assert.ok((res.headers.get('content-disposition') || '').endsWith('.tar.gz"'),
        `unexpected content-disposition ${res.headers.get('content-disposition')}`);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body[0], 0x1f, 'body is not gzip');
      assert.equal(body[1], 0x8b, 'body is not gzip');
    });

    await check('batch upload lands nested paths under one root and rejects traversal', async () => {
      const created = await fetch(base + '/upload/batch', {
        method: 'POST',
        headers: { cookie: cookieAdmin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-dir' }),
      });
      assert.equal(created.status, 200);
      const { batchId, root } = await created.json();
      uploadedPaths.push(root);
      assert.match(root, /^\/tmp\/[a-z0-9]{5}-e2e-dir$/, `unexpected root ${root}`);
      const body = Buffer.from('BATCH_BODY_' + rand + '\n');
      const one = await fetch(base + '/upload?batch=' + encodeURIComponent(batchId) +
        '&path=' + encodeURIComponent('sub/one.txt'), {
        method: 'POST',
        headers: { cookie: cookieAdmin },
        body,
      });
      assert.equal(one.status, 200);
      assert.equal((await one.json()).path, root + '/sub/one.txt');
      assert.equal(fs.readFileSync(root + '/sub/one.txt', 'utf8'), body.toString(), 'batch bytes differ from source');
      // a colliding sibling must fail-closed (409), never silently clobber the first file
      const collide = await fetch(base + '/upload?batch=' + encodeURIComponent(batchId) +
        '&path=' + encodeURIComponent('sub/one.txt'), {
        method: 'POST',
        headers: { cookie: cookieAdmin },
        body: 'CLOBBER',
      });
      assert.equal(collide.status, 409, 'a name collision must be refused, not overwrite');
      assert.equal(fs.readFileSync(root + '/sub/one.txt', 'utf8'), body.toString(), 'the original file must survive a collision');
      const evil = await fetch(base + '/upload?batch=' + encodeURIComponent(batchId) +
        '&path=' + encodeURIComponent('../evil'), {
        method: 'POST',
        headers: { cookie: cookieAdmin },
        body: 'pwned',
      });
      assert.equal(evil.status, 400, 'traversal must be rejected');
      const unknown = await fetch(base + '/upload?batch=deadbeef0000dead&path=' + encodeURIComponent('x.txt'), {
        method: 'POST',
        headers: { cookie: cookieAdmin },
        body: 'orphan',
      });
      assert.equal(unknown.status, 400, 'unknown batch must be rejected');
    });

    await check('leaving shared returns to the lobby but keeps the shared shell alive', async () => {
      // state here: sa (tanish) holds control in shared, sb (engineer-a) is a shared viewer
      sa.skipTexts();
      sb.skipTexts();
      const leftEpoch = sa.epoch;
      const binBefore = sa.bin.length;
      sa.send({ t: 'lobby' });
      const m = await sa.waitText((x) => x.t === 'mode' && x.mode === 'lobby', 5000, 'sa mode lobby');
      assert.ok(m.epoch > leftEpoch, 'leaving must bump the epoch');
      assert.ok(!('bufferBytes' in m) && !('cols' in m), 'lobby frame carries epoch only');
      // sa held control → released; the remaining viewer sees it vacated
      await sb.waitText((x) => x.t === 'state' && x.controller === null, 5000, 'control released on leave');
      await sleep(500);
      assert.equal(sa.bin.length, binBefore, 'no PTY output/replay may follow the drop to the lobby');
      // the shared shell is untouched: sb takes the vacated control and its command runs
      sb.send({ t: 'take' });
      await sb.waitText((x) => x.t === 'state' && x.controller === 'engineer-a', 5000, 'sb takes vacated control');
      const off = sb.binBytes;
      sb.send({ t: 'input', data: `echo LEFT_SHARED_AL''IVE_${rand}\r`, e: sb.epoch });
      await sb.waitBinContains(`LEFT_SHARED_ALIVE_${rand}`, off, 8000, 'shared shell still runs after a viewer left');
      // sa, now in the lobby, re-attaches; the replay carries sb's post-leave marker
      const back = await sa.attachShared(100, 30);
      assert.ok(back.bufferBytes > 0 && back.replay.includes(`LEFT_SHARED_ALIVE_${rand}`),
        'lobby→shared replay missing output produced while away');
    });

    await check('leaving a split from the panel kills the shell and returns to the lobby', async () => {
      const lx = track(new WSClient(wsUrl, cookieAdmin));
      assertHelloShape(await lx.nextText(5000, 'leave-split hello'), 'tanish', 'admin');
      lx.send({ t: 'split', cols: 100, rows: 30 });
      await lx.waitText((x) => x.t === 'mode' && x.mode === 'split', 8000, 'mode split before leave');
      lx.send({ t: 'input', data: 'echo "PID:$$:DIP"\r', e: lx.epoch });
      let pid = null;
      const parseEnd = Date.now() + 10000;
      while (Date.now() < parseEnd) {
        const mm = lx.binAll().toString('utf8').match(/PID:(\d+):DIP/);
        if (mm) { pid = Number(mm[1]); break; }
        await sleep(100);
      }
      assert.ok(Number.isInteger(pid) && pid > 1, `could not parse split pid (got ${pid})`);
      const textCount = lx.texts.length;
      lx.send({ t: 'lobby' });
      const m = await lx.waitText((x) => x.t === 'mode' && x.mode === 'lobby', 8000, 'mode lobby after leaving split');
      assert.ok(!('cols' in m) && !('bufferBytes' in m), 'lobby frame carries epoch only');
      assert.ok(!lx.texts.slice(textCount).some((x) => x.t === 'splitExited'),
        'leaving intentionally must not emit splitExited');
      let gone = false;
      const killEnd = Date.now() + 6000;
      while (Date.now() < killEnd) {
        try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') gone = true; break; }
        await sleep(200);
      }
      assert.ok(gone, `split shell pid ${pid} survived leaving to the lobby`);
      lx.ws.close();
      await lx.waitClose(5000, 'leave-split socket close');
    });

    console.log(`# ${checksPassed} checks passed`);
  } catch (e) {
    process.exitCode = 1;
    console.error(e && e.stack ? e.stack : String(e));
    if (server) {
      const err = server.getStderr().trim();
      if (err) console.error(`--- server stderr ---\n${err}`);
    }
  } finally {
    for (const p of uploadedPaths) fs.rmSync(p, { recursive: true, force: true });
    for (const c of clients) c.terminate();
    if (server && server.child.exitCode === null) {
      server.child.kill('SIGTERM');
      const gone = new Promise((r) => server.child.once('exit', r));
      await withTimeout(gone, 2000, 'server exit').catch(() => server.child.kill('SIGKILL'));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
