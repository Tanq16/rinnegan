#!/usr/bin/env node
// End-to-end test for rinnegan. Run: node test/e2e.mjs
// Exit 0 = all checks pass, 1 = failure. One "ok - ..." line per check.
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
const PORT = 0; // real port discovered from the server's "listening" line
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
    this.texts = []; // parsed JSON text frames, in arrival order
    this.cursor = 0; // waitText consumes forward-only
    this.bin = []; // binary frames
    this.binBytes = 0;
    this.closed = null;
    this.waiters = new Set();
    this.ws.on('open', () => this.#notify());
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const b = Buffer.from(data);
        this.bin.push(b);
        this.binBytes += b.length;
      } else {
        try { this.texts.push(JSON.parse(data.toString())); } catch { /* ignore unparsable */ }
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

  nextText(ms, what) { return this.waitText(() => true, ms, what); }

  waitBinContains(needle, fromByte, ms, what) {
    return this.#wait(() => {
      if (Buffer.concat(this.bin).indexOf(needle, fromByte) !== -1) return true;
      if (this.closed) throw new Error(`socket closed (code ${this.closed.code}) while waiting for ${what}`);
      return undefined;
    }, ms, what);
  }

  waitFirstBin(ms, what) {
    return this.#wait(() => {
      if (this.bin.length > 0) return this.bin[0];
      if (this.closed) throw new Error(`socket closed (code ${this.closed.code}) while waiting for ${what}`);
      return undefined;
    }, ms, what);
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

function getCookiePair(res, name) {
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith(name + '=')) return sc;
  }
  return null;
}

function assertHelloShape(msg, username, role) {
  assert.equal(msg.t, 'hello', `first message must be hello, got ${JSON.stringify(msg)}`);
  assert.ok(msg.you && msg.size && msg.state && 'bufferBytes' in msg, 'hello missing you/size/state/bufferBytes');
  assert.equal(msg.you.username, username);
  assert.equal(msg.you.role, role);
  assert.ok(Number.isInteger(msg.size.cols) && Number.isInteger(msg.size.rows), 'hello.size cols/rows must be integers');
  for (const k of ['controller', 'mode', 'viewers', 'pending']) {
    assert.ok(k in msg.state, `hello.state missing ${k}`);
  }
  assert.ok(Number.isInteger(msg.bufferBytes) && msg.bufferBytes >= 0, 'hello.bufferBytes must be a non-negative integer');
}

async function main() {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webterm-e2e-'));
  let server = null;
  const clients = [];
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

    // ---------- HTTP ----------
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

    // ---------- WebSocket ----------
    await check('WS upgrade without cookie rejected (4401)', async () => {
      const c = track(new WSClient(wsUrl, null));
      const closed = await c.waitClose(5000, 'unauthenticated ws close');
      // Contract: handshake completes only to deliver close 4401. 1006 covers a raw HTTP reject.
      assert.ok(closed.code === 4401 || closed.code === 1006, `expected 4401 (or 1006), got ${closed.code}`);
    });

    const admin = track(new WSClient(wsUrl, cookieAdmin));
    let adminHello;
    await check('WS with cookie: first message is hello with you/size/state/bufferBytes', async () => {
      adminHello = await admin.nextText(5000, 'admin hello');
      assertHelloShape(adminHello, 'tanish', 'admin');
    });

    await check('first user becomes controller', async () => {
      // spec First User Behavior: no controller => first connecting user is assigned control
      assert.equal(adminHello.state.controller, 'tanish', 'hello.state.controller must be the first user');
    });

    await check('controller input executes in shell (binary output contains marker)', async () => {
      // quote-split so the marker only appears once the shell actually runs the command
      admin.send({ t: 'input', data: "echo E2E_MAR''KER_1\r" });
      await admin.waitBinContains('E2E_MARKER_1', 0, 8000, 'E2E_MARKER_1 in pty output');
    });

    const eng = track(new WSClient(wsUrl, cookieUser));
    let engHello;
    await check('second client hello shows viewers=2', async () => {
      engHello = await eng.nextText(5000, 'engineer-a hello');
      assertHelloShape(engHello, 'engineer-a', 'user');
      assert.equal(engHello.state.viewers, 2);
      await admin.waitText((m) => m.t === 'state' && m.viewers === 2, 5000, 'admin state viewers=2');
    });

    await check('non-controller input is ignored', async () => {
      eng.send({ t: 'input', data: 'echo E2E_IGNORED_MARK\r' });
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

    await check('admin resize broadcasts size to all clients', async () => {
      admin.send({ t: 'resize', cols: 100, rows: 30 });
      await Promise.all([
        admin.waitText((m) => m.t === 'size' && m.cols === 100 && m.rows === 30, 5000, 'admin size 100x30'),
        eng.waitText((m) => m.t === 'size' && m.cols === 100 && m.rows === 30, 5000, 'engineer-a size 100x30'),
      ]);
    });

    await check('admin restart sends RIS and terminal keeps working', async () => {
      const off = admin.binBytes;
      admin.send({ t: 'restart' });
      await admin.waitBinContains('\x1bc', off, 8000, 'RIS (\\x1bc) after restart');
      await admin.waitText((m) => m.t === 'size', 5000, 'size broadcast after restart');
      admin.send({ t: 'take' });
      await admin.waitText((m) => m.t === 'state' && m.controller === 'tanish', 5000, 'controller=tanish after restart');
      admin.send({ t: 'input', data: "echo E2E_AFTER_RE''START\r" });
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

    await check('reconnect after kick replays buffer (bufferBytes > 0)', async () => {
      const c2 = track(new WSClient(wsUrl, cookieAdmin));
      const hello = await c2.nextText(5000, 'reconnect hello');
      assertHelloShape(hello, 'tanish', 'admin');
      assert.ok(hello.bufferBytes > 0, `expected bufferBytes > 0, got ${hello.bufferBytes}`);
      const frame = await c2.waitFirstBin(5000, 'buffer replay frame');
      assert.equal(frame.length, hello.bufferBytes, 'replay frame length must equal hello.bufferBytes');
      assert.ok(frame.includes('E2E_AFTER_RESTART'), 'replayed buffer missing prior output');
      c2.ws.close();
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

    console.log(`# ${checksPassed} checks passed`);
  } catch (e) {
    process.exitCode = 1;
    console.error(e && e.stack ? e.stack : String(e));
    if (server) {
      const err = server.getStderr().trim();
      if (err) console.error(`--- server stderr ---\n${err}`);
    }
  } finally {
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
