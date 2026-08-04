#!/usr/bin/env node
// End-to-end test for rinnegan. Run: node test/e2e.mjs (exit 0 = all checks pass, 1 = failure).
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import WebSocket from 'ws';
import { hashPassword } from '../src/auth.js';
import { setPassword } from '../src/password.js';
import { runTunnel, runTunnels } from '../src/tunnel-client.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin', 'rinnegan.js');
const PORT = 0; // 0 = OS-assigned; the real port is parsed from the server's "listening" line
const PASS = 'e2e-password';

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
    this.epoch = null; // session epoch from hello/started/exited; echoed as `e` in input/resize
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
          if (m.t === 'hello' || m.t === 'started' || m.t === 'exited') this.epoch = m.epoch;
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

  nextText(ms, what) { return this.waitText(() => true, ms, what); }

  waitBinContains(needle, fromByte, ms, what) {
    return this.#wait(() => {
      if (Buffer.concat(this.bin).indexOf(needle, fromByte) !== -1) return true;
      if (this.closed) throw new Error(`socket closed (code ${this.closed.code}) while waiting for ${what}`);
      return undefined;
    }, ms, what);
  }

  async start(cols, rows, ms = 8000) {
    this.send({ t: 'start', cols, rows });
    const m = await this.waitText((x) => x.t === 'started', ms, 'started reply');
    assert.ok(Number.isInteger(m.cols) && Number.isInteger(m.rows), 'started must carry cols/rows');
    assert.ok(Number.isInteger(m.epoch), 'started must carry an epoch');
    return m;
  }

  waitClose(ms, what) {
    return this.#wait(() => this.closed ?? undefined, ms, what);
  }

  binAll() { return Buffer.concat(this.bin); }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  terminate() { try { this.ws.terminate(); } catch { /* already dead */ } }
}

function startServer(homeDir, extraArgs = []) {
  const child = spawn(process.execPath, [BIN, 'serve', ...extraArgs], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: homeDir },
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

// `rinnegan passwd` refuses a non-TTY stdin, so driving it needs a real PTY rather than a pipe.
function runPasswd(homeDir, password) {
  const p = pty.spawn(process.execPath, [BIN, 'passwd'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: ROOT,
    env: { ...process.env, HOME: homeDir },
  });
  let out = '';
  let answered = 0;
  const done = new Promise((resolve, reject) => {
    p.onData((d) => {
      out += d;
      const prompts = (out.match(/assword: /g) || []).length;
      while (answered < Math.min(2, prompts)) {
        p.write(password + '\r');
        answered++;
      }
    });
    p.onExit(({ exitCode }) => {
      if (exitCode === 0) resolve(out);
      else reject(new Error(`passwd exited ${exitCode}\n--- passwd output ---\n${out}`));
    });
  });
  return withTimeout(done, 15000, 'rinnegan passwd to finish');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
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

// `/usr/bin/env sh -l` is deliberately outside the --shell allowlist: config.json stays the arbitrary-command escape hatch.
function writeServerConfig(cfgDir, cwd, shell = '/usr/bin/env sh -l') {
  return fs.promises.writeFile(path.join(cfgDir, 'config.json'), JSON.stringify({
    listen: { host: '127.0.0.1', port: PORT },
    cookie: { secure: false, name: 'rinnegan', accessTtlSeconds: 3600, refreshTtlSeconds: 604800 },
    terminal: { shell, cwd, cols: 120, rows: 36 },
  }, null, 2) + '\n');
}

function assertHelloShape(msg, { authOn = true } = {}) {
  assert.equal(msg.t, 'hello', `first message must be hello, got ${JSON.stringify(msg)}`);
  assert.ok(Number.isInteger(msg.epoch), 'hello.epoch must be an integer');
  assert.equal(msg.authOn, authOn, `hello.authOn must be ${authOn}`);
  assert.ok(msg.host && typeof msg.host === 'object', 'hello must carry host info');
  assert.equal(typeof msg.host.hostname, 'string', 'host.hostname must be a string');
  assert.equal(typeof msg.host.platform, 'string', 'host.platform must be a string');
  assert.equal(typeof msg.host.user, 'string', 'host.user must be a string');
  assert.ok(typeof msg.host.shell === 'string' && msg.host.shell.length > 0, 'host.shell must name the resolved shell');
  for (const dead of ['you', 'size', 'state', 'offerShared', 'bufferBytes']) {
    assert.ok(!(dead in msg), `hello must not carry ${dead}`);
  }
  if (authOn) assert.equal(typeof msg.accessExpiresAt, 'number', 'an authenticated hello must carry accessExpiresAt');
  else assert.equal(msg.accessExpiresAt, null, 'a no-auth hello must carry a null accessExpiresAt');
}

async function withTempServer({ password, noAuth, shell, seed, args = [] }, fn) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webterm-tmp-'));
  const cfgDir = path.join(home, '.config', 'rinnegan');
  await fs.promises.mkdir(cfgDir, { recursive: true });
  await writeServerConfig(cfgDir, home, shell);
  const authFile = path.join(cfgDir, 'auth.json');
  if (password) {
    await fs.promises.writeFile(authFile,
      JSON.stringify({ password: await hashPassword(password) }, null, 2) + '\n', { mode: 0o600 });
  }
  if (seed) await seed({ home, cfgDir, authFile });
  const srv = startServer(home, noAuth ? ['--no-auth', ...args] : args);
  srv.authFile = authFile;
  try {
    return await fn(srv);
  } finally {
    if (srv.child.exitCode === null) {
      srv.child.kill('SIGTERM');
      const gone = new Promise((r) => srv.child.once('exit', r));
      await withTimeout(gone, 2000, 'temp server exit').catch(() => srv.child.kill('SIGKILL'));
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const loginFor = async (port, password = PASS) => {
  const res = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ password }),
  });
  assert.equal(res.status, 302, 'login must redirect');
  return getCookiePair(res, 'rinnegan').split(';')[0];
};

async function main() {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webterm-e2e-'));
  let server = null;
  const clients = [];
  const uploadedPaths = []; // /tmp files, batch roots and dirs created by transfer checks; removed in finally
  const track = (c) => { clients.push(c); return c; };
  const rand = Math.random().toString(36).slice(2, 10);

  try {
    await check('serve with no auth.json refuses to start', async () => {
      await withTempServer({}, async (srv) => {
        srv.ready.catch(() => {}); // no port is ever printed; we assert on the exit instead
        const code = await withTimeout(new Promise((r) => srv.child.once('exit', r)), 8000, 'server exit');
        assert.equal(code, 1, `expected exit 1 with no auth.json, got ${code}`);
        const err = srv.getStderr();
        assert.match(err, /rinnegan passwd/, 'error must name `rinnegan passwd`');
        assert.match(err, /--no-auth/, 'error must name --no-auth');
      });
    });

    await check('passwd seeds auth.json where serve reads it, and that password logs in', async () => {
      await withTempServer({
        seed: async ({ home, authFile }) => {
          await runPasswd(home, 'set-by-passwd');
          const raw = await fs.promises.readFile(authFile, 'utf8');
          assert.equal(typeof JSON.parse(raw).password?.hash, 'string', 'passwd must write a derived hash under "password"');
          assert.ok(!raw.includes('set-by-passwd'), 'passwd must never store the plaintext');
          assert.equal((await fs.promises.stat(authFile)).mode & 0o777, 0o600, 'auth.json must be owner-only');
        },
      }, async (srv) => {
        const { port } = await withTimeout(srv.ready, 15000, 'server listening after passwd');
        const cookie = await loginFor(port, 'set-by-passwd');
        assert.ok(cookie.length > 'rinnegan='.length, 'the password set by passwd must log in');
      });
    });

    await check('serve --no-auth skips the login page and still serves a terminal', async () => {
      await withTempServer({ noAuth: true }, async (srv) => {
        const { port } = await withTimeout(srv.ready, 15000, 'no-auth server listening');
        const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
        assert.equal(root.status, 200, 'GET / must serve the SPA without a cookie under --no-auth');
        // With no password to check, a login POST would only cost a file read and a scrypt derivation.
        for (const [path, init] of [['/login', {}], ['/login', { method: 'POST', body: 'password=x' }], ['/logout', { method: 'POST' }]]) {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init });
          assert.equal(res.status, 404, `${init.method ?? 'GET'} ${path} must be unrouted under --no-auth`);
        }
        const c = new WSClient(`ws://127.0.0.1:${port}/ws`, null);
        try {
          assertHelloShape(await c.nextText(5000, 'no-auth hello'), { authOn: false });
          await c.start(100, 30);
          c.send({ t: 'input', data: `echo NOAUTH_MAR''KER_${rand}\r`, e: c.epoch });
          await c.waitBinContains(`NOAUTH_MARKER_${rand}`, 0, 10000, 'no-auth shell output');
        } finally {
          c.terminate();
        }
        const warn = srv.getStderr();
        assert.match(warn, /--no-auth disables authentication/, 'must warn that auth is disabled');
        assert.equal((warn.match(/--no-auth disables authentication/g) || []).length, 1,
          'exactly one --no-auth warning line');
      });
    });

    await check('--shell bash boots and runs a bash-identifying command', async () => {
      await withTempServer({ password: PASS, args: ['--shell', 'bash'] }, async (srv) => {
        const { port } = await withTimeout(srv.ready, 15000, '--shell bash server listening');
        const cookie = await loginFor(port);
        const c = new WSClient(`ws://127.0.0.1:${port}/ws`, cookie);
        try {
          const hello = await c.nextText(5000, '--shell bash hello');
          assertHelloShape(hello);
          assert.equal(hello.host.shell, '/usr/bin/env bash -l', '--shell must override terminal.shell from config.json');
          await c.start(100, 30);
          // the typed line carries no digit after the underscore; only bash's expansion supplies one
          c.send({ t: 'input', data: 'echo SHELL_IS_${BASH_VERSION}_END\r', e: c.epoch });
          await c.waitBinContains('SHELL_IS_', 0, 10000, 'bash version echo');
          const seen = await (async () => {
            const end = Date.now() + 10000;
            while (Date.now() < end) {
              const m = c.binAll().toString('utf8').match(/SHELL_IS_\d[^\s]*_END/);
              if (m) return m[0];
              await sleep(100);
            }
            return null;
          })();
          assert.ok(seen, 'the spawned shell did not expand $BASH_VERSION, so it was not bash');
        } finally {
          c.terminate();
        }
      });
    });

    await check('--shell with an unaccepted value refuses to start', async () => {
      await withTempServer({ password: PASS, args: ['--shell', 'bogus'] }, async (srv) => {
        srv.ready.catch(() => {});
        const code = await withTimeout(new Promise((r) => srv.child.once('exit', r)), 8000, 'server exit');
        assert.equal(code, 1, `expected exit 1 for --shell bogus, got ${code}`);
        assert.match(srv.getStderr(), /--shell must be one of/, 'error must name the accepted shells');
      });
    });

    await check('a shell that cannot be spawned reports back instead of hanging', async () => {
      await withTempServer({ password: PASS, shell: '/nonexistent/rinnegan-e2e-shell -l' }, async (srv) => {
        const { port } = await withTimeout(srv.ready, 15000, 'bad-shell server listening');
        const cookie = await loginFor(port);
        const c = new WSClient(`ws://127.0.0.1:${port}/ws`, cookie);
        try {
          assertHelloShape(await c.nextText(5000, 'bad-shell hello'));
          c.send({ t: 'start', cols: 100, rows: 30 });
          // whichever way node-pty reports it, the socket must end with no shell and the client on the start card
          const m = await c.waitText((x) => x.t === 'exited' || x.t === 'error', 10000, 'spawn failure report');
          if (m.t === 'exited') assert.ok(Number.isInteger(m.epoch), 'exited must carry an epoch');
          else assert.equal(typeof m.msg, 'string', 'error must carry a message');
        } finally {
          c.terminate();
        }
      });
    });

    await check('rotating the password invalidates a live session on refresh', async () => {
      await withTempServer({ password: PASS }, async (srv) => {
        const { port } = await withTimeout(srv.ready, 15000, 'rotation server listening');
        const res = await fetch(`http://127.0.0.1:${port}/login`, {
          method: 'POST',
          redirect: 'manual',
          body: new URLSearchParams({ password: PASS }),
        });
        assert.equal(res.status, 302);
        const refreshCookie = getCookiePair(res, 'rinnegan_rt').split(';')[0];
        const before = await fetch(`http://127.0.0.1:${port}/refresh`, { method: 'POST', headers: { cookie: refreshCookie } });
        assert.equal(before.status, 200, 'the refresh cookie must work before the rotation');

        await setPassword(srv.authFile, 'a-brand-new-password');
        const after = await fetch(`http://127.0.0.1:${port}/refresh`, { method: 'POST', headers: { cookie: refreshCookie } });
        assert.equal(after.status, 401, 'a rotated password must stop the old session refreshing');
        const freshLogin = await fetch(`http://127.0.0.1:${port}/login`, {
          method: 'POST',
          redirect: 'manual',
          body: new URLSearchParams({ password: 'a-brand-new-password' }),
        });
        assert.equal(freshLogin.status, 302, 'the new password must log in');
        const freshRefresh = getCookiePair(freshLogin, 'rinnegan_rt').split(';')[0];
        const renewed = await fetch(`http://127.0.0.1:${port}/refresh`, { method: 'POST', headers: { cookie: freshRefresh } });
        assert.equal(renewed.status, 200, 'a session minted after the rotation must refresh against the new fingerprint');
      });
    });

    const cfgDir = path.join(tmp, '.config', 'rinnegan');
    await fs.promises.mkdir(cfgDir, { recursive: true });
    await fs.promises.writeFile(path.join(cfgDir, 'auth.json'),
      JSON.stringify({ password: await hashPassword(PASS) }, null, 2) + '\n', { mode: 0o600 });
    await writeServerConfig(cfgDir, tmp);

    server = startServer(tmp);
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

    await check('GET /login serves html with a password field and no username field', async () => {
      const res = await get('/login');
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').includes('text/html'));
      const html = await res.text();
      assert.match(html, /name="password"/, 'login must offer a password field');
      assert.doesNotMatch(html, /name="username"/, 'the collapsed login must have no username field');
    });

    await check('login page ships the silent-resume probe', async () => {
      const html = await (await get('/login')).text();
      assert.match(html, /fetch\(\s*['"]\/refresh['"]/, 'login must POST /refresh on load to silently resume a valid session');
    });

    await check('vendored css and fonts are served (terminal glyphs depend on it)', async () => {
      const css = await get('/css/jetbrains-mono.css');
      assert.equal(css.status, 200, '/css must be served, else the Nerd Font never loads');
      assert.ok((css.headers.get('content-type') || '').includes('text/css'), '/css wrong content-type');
      const font = await get('/fonts/JetBrainsMonoNerdFontMono-Regular.woff2');
      assert.equal(font.status, 200, '/fonts woff2 must be served');
      assert.equal(font.headers.get('content-type'), 'font/woff2', 'woff2 wrong content-type');
    });

    await check('POST /login wrong password redirects with error', async () => {
      const res = await post('/login', { password: 'wrong-password' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login?error=1');
      assert.equal(getCookiePair(res, 'rinnegan'), null, 'must not set session cookie on bad login');
    });

    await check('POST /login with an empty body is refused', async () => {
      const res = await post('/login', {});
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login?error=1');
      assert.equal(getCookiePair(res, 'rinnegan'), null, 'an empty login must not set a session cookie');
    });

    let cookie, refreshCookie;
    await check('POST /login correct sets both HttpOnly cookies and redirects to /', async () => {
      const res = await post('/login', { password: PASS });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      const sc = getCookiePair(res, 'rinnegan');
      assert.ok(sc, 'missing Set-Cookie for rinnegan');
      assert.ok(/httponly/i.test(sc), 'cookie must be HttpOnly');
      cookie = sc.split(';')[0];
      assert.ok(cookie.length > 'rinnegan='.length, 'cookie value empty');
      const rt = getCookiePair(res, 'rinnegan_rt');
      assert.ok(rt, 'missing Set-Cookie for rinnegan_rt');
      assert.ok(/httponly/i.test(rt), 'refresh cookie must be HttpOnly');
      assert.ok(/path=\/refresh/i.test(rt), 'refresh cookie must be scoped to /refresh');
      refreshCookie = rt.split(';')[0];
    });

    await check('POST /refresh with the refresh cookie mints a fresh access cookie', async () => {
      const res = await post('/refresh', {}, refreshCookie);
      assert.equal(res.status, 200);
      const sc = getCookiePair(res, 'rinnegan');
      assert.ok(sc, '/refresh must set a fresh access cookie');
      assert.ok(/httponly/i.test(sc), 'refreshed access cookie must be HttpOnly');
      const json = await res.json();
      assert.equal(typeof json.accessExpiresAt, 'number', 'refresh response must carry a numeric accessExpiresAt');
    });

    await check('POST /refresh without the refresh cookie is rejected (401)', async () => {
      const res = await post('/refresh', {});
      assert.equal(res.status, 401);
      assert.equal(getCookiePair(res, 'rinnegan'), null, 'a rejected refresh must not set a cookie');
    });

    await check('GET / with cookie serves terminal page', async () => {
      const res = await get('/', cookie);
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

    await check('WS upgrade without cookie rejected (4401)', async () => {
      const c = track(new WSClient(wsUrl, null));
      const closed = await c.waitClose(5000, 'unauthenticated ws close');
      // WS auth must reject before accepting the socket: handshake completes only to deliver 4401 (1006 = raw HTTP reject)
      assert.ok(closed.code === 4401 || closed.code === 1006, `expected 4401 (or 1006), got ${closed.code}`);
    });

    await check('tunnel round-trips bytes to a loopback service', async () => {
      const echo = net.createServer((s) => s.pipe(s));
      await new Promise((r) => echo.listen(0, '127.0.0.1', r));
      const echoPort = echo.address().port;
      const c = track(new WSClient(`ws://127.0.0.1:${port}/tunnel?port=${echoPort}`, cookie));
      try {
        await c.waitOpen(5000);
        c.ws.send(Buffer.from('E2E_TUNNEL_ROUNDTRIP'));
        await c.waitBinContains('E2E_TUNNEL_ROUNDTRIP', 0, 5000, 'tunnel echo bytes');
      } finally {
        c.ws.close();
        echo.close();
      }
    });

    await check('unauthenticated /tunnel upgrade rejected (4401)', async () => {
      const c = track(new WSClient(`ws://127.0.0.1:${port}/tunnel?port=1`, null));
      const closed = await c.waitClose(5000, 'unauthenticated tunnel close');
      assert.ok(closed.code === 4401 || closed.code === 1006, `expected 4401 (or 1006), got ${closed.code}`);
    });

    await check('/tunnel with a bad port rejected (4400)', async () => {
      const c = track(new WSClient(`ws://127.0.0.1:${port}/tunnel?port=0`, cookie));
      const closed = await c.waitClose(5000, 'bad-port tunnel close');
      assert.equal(closed.code, 4400, `expected 4400, got ${closed.code}`);
    });

    await check('client runTunnel logs in with a password alone and round-trips bytes', async () => {
      const echo = net.createServer((s) => s.pipe(s));
      await new Promise((r) => echo.listen(0, '127.0.0.1', r));
      const echoPort = echo.address().port;
      const localPort = await freePort();
      const listener = await runTunnel({
        server: base, localPort, remotePort: echoPort, password: PASS, insecure: false,
      });
      const sock = net.connect(localPort, '127.0.0.1');
      try {
        const got = await withTimeout(new Promise((resolve, reject) => {
          const chunks = [];
          sock.on('data', (d) => {
            chunks.push(d);
            if (Buffer.concat(chunks).includes('E2E_CLIENT_TUNNEL')) resolve(Buffer.concat(chunks));
          });
          sock.on('error', reject);
          sock.on('connect', () => sock.write('E2E_CLIENT_TUNNEL'));
        }), 5000, 'client tunnel echo bytes');
        assert.ok(got.includes('E2E_CLIENT_TUNNEL'), 'client tunnel did not echo bytes end-to-end');
      } finally {
        sock.destroy();
        listener.close();
        echo.close();
      }
    });

    await check('client runTunnels forwards several ports over one login', async () => {
      const mkEcho = async (tag) => {
        const echo = net.createServer((s) => s.pipe(s));
        await new Promise((r) => echo.listen(0, '127.0.0.1', r));
        return { echo, port: echo.address().port, tag: `E2E_MULTI_${tag}` };
      };
      const a = await mkEcho('A');
      const b = await mkEcho('B');
      const localA = await freePort();
      const localB = await freePort();
      const listeners = await runTunnels({
        server: base, password: PASS, insecure: false,
        mappings: [{ local: localA, remote: a.port }, { local: localB, remote: b.port }],
      });
      const roundTrip = (localPort, tag) => withTimeout(new Promise((resolve, reject) => {
        const sock = net.connect(localPort, '127.0.0.1');
        const chunks = [];
        sock.on('data', (d) => {
          chunks.push(d);
          if (Buffer.concat(chunks).includes(tag)) { sock.destroy(); resolve(); }
        });
        sock.on('error', reject);
        sock.on('connect', () => sock.write(tag));
      }), 5000, `${tag} echo bytes`);
      try {
        await Promise.all([roundTrip(localA, a.tag), roundTrip(localB, b.tag)]);
        assert.equal(listeners.length, 2, 'runTunnels should return one listener per mapping');
      } finally {
        for (const l of listeners) l.close();
        a.echo.close();
        b.echo.close();
      }
    });

    const term = track(new WSClient(wsUrl, cookie));
    await check('WS with cookie: hello carries epoch/authOn/host and nothing spawns until asked', async () => {
      assertHelloShape(await term.nextText(5000, 'terminal hello'));
      await sleep(800);
      assert.equal(term.bin.length, 0, 'no PTY output may arrive before a start');
      assert.ok(!term.texts.some((m) => m.t === 'started'), 'the server must not auto-start a shell');
    });

    await check('start spawns a terminal and echoes the requested grid', async () => {
      const m = await term.start(100, 30);
      assert.equal(m.cols, 100);
      assert.equal(m.rows, 30);
      assert.ok(m.epoch > 0, 'start must bump the session epoch past hello');
    });

    await check('input runs in the shell', async () => {
      // quote-split so the marker only materializes once the shell actually runs the command
      term.send({ t: 'input', data: `echo E2E_MAR''KER_${rand}\r`, e: term.epoch });
      await term.waitBinContains(`E2E_MARKER_${rand}`, 0, 10000, 'marker in pty output');
    });

    await check('input with a stale session epoch is dropped', async () => {
      const off = term.binBytes;
      term.send({ t: 'input', data: `echo E2E_STALE_EP''OCH_${rand}\r`, e: term.epoch + 1 });
      term.send({ t: 'input', data: `echo E2E_STALE_EP''OCH_${rand}\r` });
      term.send({ t: 'input', data: `echo E2E_STALE_EP''OCH_${rand}\r`, e: term.epoch - 1 });
      await sleep(1500);
      assert.ok(!term.binAll().slice(off).includes(`E2E_STALE_EPOCH_${rand}`), 'stale-epoch input reached the pty');
    });

    await check('start clamps the requested grid to 20..500 cols and 5..200 rows', async () => {
      const cc = track(new WSClient(wsUrl, cookie));
      assertHelloShape(await cc.nextText(5000, 'clamp hello'));
      const m = await cc.start(9999, 1);
      assert.equal(m.cols, 500);
      assert.equal(m.rows, 5);
      cc.ws.close();
      await cc.waitClose(5000, 'clamp socket close');
    });

    await check('resize resizes the socket\'s own pty', async () => {
      term.send({ t: 'resize', cols: 90, rows: 25, e: term.epoch });
      await sleep(300); // let the resize land before querying
      const off = term.binBytes;
      term.send({ t: 'input', data: 'stty size\r', e: term.epoch });
      await term.waitBinContains('25 90', off, 10000, '"25 90" from stty size');
    });

    await check('one socket\'s output is isolated from another\'s', async () => {
      const other = track(new WSClient(wsUrl, cookie));
      assertHelloShape(await other.nextText(5000, 'isolation hello'));
      await other.start(100, 30);
      other.send({ t: 'input', data: `echo ISOLA''TED_${rand}\r`, e: other.epoch });
      await other.waitBinContains(`ISOLATED_${rand}`, 0, 10000, 'own output on the second socket');
      await sleep(1000); // window for any (wrongly broadcast) output to cross over
      assert.ok(!term.binAll().includes(`ISOLATED_${rand}`), 'output leaked across sockets');
      other.ws.close();
      await other.waitClose(5000, 'isolation socket close');
    });

    await check('exiting the shell sends one exited frame and a fresh start works', async () => {
      const ec = track(new WSClient(wsUrl, cookie));
      assertHelloShape(await ec.nextText(5000, 'exit hello'));
      const first = await ec.start(100, 30);
      ec.send({ t: 'input', data: 'exit\r', e: first.epoch });
      const exited = await ec.waitText((m) => m.t === 'exited', 10000, 'exited');
      assert.ok('code' in exited, 'exited missing exit code');
      assert.ok(Number.isInteger(exited.epoch) && exited.epoch > first.epoch, 'exited must bump the epoch');
      const binCount = ec.bin.length;
      const textCount = ec.texts.length;
      await sleep(800);
      assert.equal(ec.bin.length, binCount, 'no output may follow the exit');
      const after = ec.texts.slice(textCount);
      assert.ok(!after.some((x) => x.t === 'started'), 'nothing may auto-restart server-side');
      assert.ok(!after.some((x) => x.t === 'exited'), 'the exit must be reported exactly once');

      const second = await ec.start(100, 30);
      assert.ok(second.epoch > exited.epoch, 'a start after the exit must bump the epoch again');
      const off = ec.binBytes;
      ec.send({ t: 'input', data: `echo AFTER_EX''IT_${rand}\r`, e: ec.epoch });
      await ec.waitBinContains(`AFTER_EXIT_${rand}`, off, 10000, 'output from the shell started after the exit');
      ec.ws.close();
      await ec.waitClose(5000, 'exit socket close');
    });

    await check('a restart\'s dead shell does not knock its live successor offline', async () => {
      const rc = track(new WSClient(wsUrl, cookie));
      assertHelloShape(await rc.nextText(5000, 'restart hello'));
      const first = await rc.start(100, 30);
      rc.send({ t: 'input', data: `echo RESTART_BEF''ORE_${rand}\r`, e: rc.epoch });
      await rc.waitBinContains(`RESTART_BEFORE_${rand}`, 0, 10000, 'first shell output');

      const textCount = rc.texts.length;
      const second = await rc.start(100, 30);
      assert.ok(second.epoch > first.epoch, 'a restart must bump the epoch');
      await sleep(1200); // window for the killed shell's exit to land on its successor
      assert.ok(!rc.texts.slice(textCount).some((x) => x.t === 'exited'),
        'the killed shell must not emit exited over a live successor');
      const off = rc.binBytes;
      rc.send({ t: 'input', data: `echo RESTART_AFT''ER_${rand}\r`, e: rc.epoch });
      await rc.waitBinContains(`RESTART_AFTER_${rand}`, off, 10000, 'restarted shell output');
      rc.ws.close();
      await rc.waitClose(5000, 'restart socket close');
    });

    await check('disconnect kills the shell process', async () => {
      const sd = track(new WSClient(wsUrl, cookie));
      assertHelloShape(await sd.nextText(5000, 'disconnect hello'));
      await sd.start(100, 30);
      // $$ expands only when the shell runs it; the typed echo has no digits there
      sd.send({ t: 'input', data: 'echo "PID:$$:DIP"\r', e: sd.epoch });
      let pid = null;
      const parseEnd = Date.now() + 10000;
      while (Date.now() < parseEnd) {
        const m = sd.binAll().toString('utf8').match(/PID:(\d+):DIP/);
        if (m) { pid = Number(m[1]); break; }
        await sleep(100);
      }
      assert.ok(Number.isInteger(pid) && pid > 1, `could not parse shell pid (got ${pid})`);
      process.kill(pid, 0); // must be alive before the disconnect
      sd.terminate();
      let gone = false;
      const killEnd = Date.now() + 6000;
      while (Date.now() < killEnd) {
        try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { gone = true; } break; }
        await sleep(200);
      }
      assert.ok(gone, `shell pid ${pid} still alive after disconnect`);
    });

    await check('tmux server survives shell death (skipped without tmux)', async () => {
      if (await runCmd('tmux', ['-V']) !== 0) {
        console.log('# note: tmux not on PATH — skipping tmux survival check');
        return;
      }
      const sess = `webterm-e2e-${process.pid}`;
      const se = track(new WSClient(wsUrl, cookie));
      assertHelloShape(await se.nextText(5000, 'tmux hello'));
      await se.start(100, 30);
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
        console.log('# note: tmux unusable inside the shell — skipping tmux survival check');
        se.ws.close();
        return;
      }
      assert.ok(started, 'timed out waiting for tmux new-session');
      try {
        se.terminate(); // kills the pty immediately
        await sleep(1000); // give the shell time to die
        assert.equal(await runCmd('tmux', ['has-session', '-t', sess]), 0,
          'tmux session must survive the shell being killed');
      } finally {
        await runCmd('tmux', ['kill-session', '-t', sess]); // clean up ONLY our session
      }
    });

    const uploadBody = Buffer.from('E2E_UPLOAD_BODY_' + rand + '\n');
    let uploadedFile;

    await check('POST /upload streams a file to /tmp with a 5-char random prefix', async () => {
      const res = await fetch(base + '/upload?name=e2e-upload.txt', {
        method: 'POST',
        headers: { cookie },
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
        headers: { cookie },
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
        headers: { cookie },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(uploadBody.length));
      assert.ok((head.headers.get('content-disposition') || '').includes('attachment'),
        'download must be sent as an attachment');
      const res = await fetch(base + '/download?path=' + encodeURIComponent(uploadedFile), {
        headers: { cookie },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), uploadBody, 'downloaded bytes differ from source');
    });

    await check('download probe rejects bad paths', async () => {
      const missing = await fetch(base + '/download?path=/tmp/e2e-missing-' + rand, {
        method: 'HEAD',
        headers: { cookie },
      });
      assert.equal(missing.status, 404);
      const rel = await fetch(base + '/download?path=relative', { headers: { cookie } });
      assert.equal(rel.status, 400);
    });

    await check('directory download arrives as tar.gz', async () => {
      const dir = '/tmp/e2e-dl-' + rand;
      fs.mkdirSync(dir, { recursive: true });
      uploadedPaths.push(dir);
      fs.writeFileSync(path.join(dir, 'inside.txt'), 'DIR_BODY_' + rand + '\n');
      const res = await fetch(base + '/download?path=' + encodeURIComponent(dir), { headers: { cookie } });
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
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'e2e-dir' }),
      });
      assert.equal(created.status, 200);
      const { batchId, root } = await created.json();
      uploadedPaths.push(root);
      assert.match(root, /^\/tmp\/[a-z0-9]{5}-e2e-dir$/, `unexpected root ${root}`);
      const body = Buffer.from('BATCH_BODY_' + rand + '\n');
      const one = await fetch(base + '/upload?batch=' + encodeURIComponent(batchId) +
        '&path=' + encodeURIComponent('sub/one.txt'), { method: 'POST', headers: { cookie }, body });
      assert.equal(one.status, 200);
      assert.equal((await one.json()).path, root + '/sub/one.txt');
      assert.equal(fs.readFileSync(root + '/sub/one.txt', 'utf8'), body.toString(), 'batch bytes differ from source');
      // a colliding sibling must fail-closed (409), never silently clobber the first file
      const collide = await fetch(base + '/upload?batch=' + encodeURIComponent(batchId) +
        '&path=' + encodeURIComponent('sub/one.txt'), { method: 'POST', headers: { cookie }, body: 'CLOBBER' });
      assert.equal(collide.status, 409, 'a name collision must be refused, not overwrite');
      assert.equal(fs.readFileSync(root + '/sub/one.txt', 'utf8'), body.toString(), 'the original file must survive a collision');
      const evil = await fetch(base + '/upload?batch=' + encodeURIComponent(batchId) +
        '&path=' + encodeURIComponent('../evil'), { method: 'POST', headers: { cookie }, body: 'pwned' });
      assert.equal(evil.status, 400, 'traversal must be rejected');
      const unknown = await fetch(base + '/upload?batch=deadbeef0000dead&path=' + encodeURIComponent('x.txt'),
        { method: 'POST', headers: { cookie }, body: 'orphan' });
      assert.equal(unknown.status, 400, 'unknown batch must be rejected');
    });

    await check('POST /logout clears the cookie', async () => {
      const res = await post('/logout', {}, cookie);
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
