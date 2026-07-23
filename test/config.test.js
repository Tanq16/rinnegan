import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, loadState, saveState } from '../src/config.js';

let dir, prevHome, CONFIG_DIR;
before(() => {
  prevHome = process.env.HOME;
  dir = mkdtempSync(path.join(tmpdir(), 'rinnegan-config-'));
  process.env.HOME = dir;
  CONFIG_DIR = path.join(dir, '.config', 'rinnegan');
  mkdirSync(CONFIG_DIR, { recursive: true });
});
after(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

const configFile = () => path.join(CONFIG_DIR, 'config.json');
function writeConfig(value) {
  writeFileSync(configFile(), typeof value === 'string' ? value : JSON.stringify(value));
}

test('loadConfig fills defaults from a minimal config', () => {
  writeConfig({});
  const cfg = loadConfig();
  assert.equal(cfg.listen.port, 8442);
  assert.equal(cfg.listen.host, '127.0.0.1');
  assert.equal(cfg.cookie.name, 'rinnegan');
  assert.equal(cfg.cookie.secure, false);
  assert.equal(cfg.cookie.accessTtlSeconds, 10800);
  assert.equal(cfg.cookie.refreshTtlSeconds, 604800);
  assert.equal(cfg.terminal.cols, 120);
  assert.equal(cfg.terminal.env.TERM, 'xterm-256color');
  assert.equal(cfg.control.mode, 'soft');
  assert.equal(cfg.buffer.maxBytes, 2097152);
  assert.equal(typeof cfg.terminal.cwd, 'string');
  assert.ok(cfg.terminal.cwd.length > 0);
  assert.equal(cfg.usersFile, path.join(CONFIG_DIR, 'users.json'));
  assert.equal(cfg.stateFile, path.join(CONFIG_DIR, 'state.json'));
});

test('loadConfig seeds a 0600 config.json from defaults when it is missing', () => {
  rmSync(configFile(), { force: true });
  assert.equal(existsSync(configFile()), false);
  const cfg = loadConfig();
  assert.equal(existsSync(configFile()), true);
  assert.equal(statSync(configFile()).mode & 0o777, 0o600);
  assert.equal(cfg.listen.port, 8442);
  assert.equal(cfg.usersFile, path.join(CONFIG_DIR, 'users.json'));
  assert.equal(cfg.stateFile, path.join(CONFIG_DIR, 'state.json'));
});

test('loadConfig deep-merges nested overrides while keeping sibling defaults', () => {
  writeConfig({ cookie: { secure: true } });
  const cfg = loadConfig();
  assert.equal(cfg.cookie.secure, true);
  assert.equal(cfg.cookie.name, 'rinnegan');
  assert.equal(cfg.cookie.accessTtlSeconds, 10800);
});

test('loadConfig merges a deeply nested object keeping unmentioned keys', () => {
  writeConfig({ terminal: { env: { TERM: 'screen-256color' } } });
  const cfg = loadConfig();
  assert.equal(cfg.terminal.env.TERM, 'screen-256color');
  assert.equal(cfg.terminal.env.COLORTERM, 'truecolor');
  assert.equal(cfg.terminal.env.LANG, 'en_US.UTF-8');
});

test('loadConfig treats an empty object override as no change', () => {
  writeConfig({ terminal: {} });
  const cfg = loadConfig();
  assert.equal(cfg.terminal.shell, '/usr/bin/env zsh -l');
  assert.equal(cfg.terminal.rows, 36);
});

test('loadConfig keeps an explicit terminal.cwd override', () => {
  writeConfig({ terminal: { cwd: '/tmp/somewhere' } });
  const cfg = loadConfig();
  assert.equal(cfg.terminal.cwd, '/tmp/somewhere');
});

test('loadConfig resolves relative users/state paths against the config dir', () => {
  writeConfig({ usersFile: './creds.json', stateFile: '../shared/state.json' });
  const cfg = loadConfig();
  assert.equal(cfg.usersFile, path.resolve(CONFIG_DIR, './creds.json'));
  assert.equal(cfg.stateFile, path.resolve(CONFIG_DIR, '../shared/state.json'));
});

test('loadConfig ignores a __proto__ key without polluting Object.prototype', () => {
  writeConfig('{"__proto__":{"polluted":true},"listen":{"port":9000}}');
  const cfg = loadConfig();
  assert.equal(cfg.listen.port, 9000);
  assert.equal({}.polluted, undefined);
});

test('loadConfig throws on malformed or non-object input', () => {
  writeConfig('{ not json');
  assert.throws(() => loadConfig(), /invalid JSON in config file/);
  writeConfig('[]');
  assert.throws(() => loadConfig(), /config must be a JSON object/);
  writeConfig('5');
  assert.throws(() => loadConfig(), /config must be a JSON object/);
  writeConfig({ listen: 5 });
  assert.throws(() => loadConfig(), /listen must be an object/);
});

test('loadConfig validation boundaries', async (t) => {
  const cases = [
    { name: 'port 0 ok', over: { listen: { port: 0 } } },
    { name: 'port 65535 ok', over: { listen: { port: 65535 } } },
    { name: 'port 65536 rejected', over: { listen: { port: 65536 } }, err: /listen\.port/ },
    { name: 'port -1 rejected', over: { listen: { port: -1 } }, err: /listen\.port/ },
    { name: 'port non-integer rejected', over: { listen: { port: 1.5 } }, err: /listen\.port/ },
    { name: 'empty host rejected', over: { listen: { host: '' } }, err: /listen\.host/ },
    { name: 'whitespace host rejected', over: { listen: { host: '   ' } }, err: /listen\.host/ },
    { name: 'empty shell rejected', over: { terminal: { shell: '' } }, err: /terminal\.shell/ },
    { name: 'cols 1 ok', over: { terminal: { cols: 1 } } },
    { name: 'cols 0 rejected', over: { terminal: { cols: 0 } }, err: /terminal\.cols/ },
    { name: 'rows 0 rejected', over: { terminal: { rows: 0 } }, err: /terminal\.rows/ },
    { name: 'mode fast ok', over: { control: { mode: 'fast' } } },
    { name: 'mode invalid rejected', over: { control: { mode: 'turbo' } }, err: /control\.mode/ },
    { name: 'stale 0 rejected', over: { control: { staleControllerSeconds: 0 } }, err: /staleControllerSeconds/ },
    { name: 'requestTimeout 0 rejected', over: { control: { requestTimeoutSeconds: 0 } }, err: /requestTimeoutSeconds/ },
    { name: 'maxBytes 65536 ok', over: { buffer: { maxBytes: 65536 } } },
    { name: 'maxBytes 65535 rejected', over: { buffer: { maxBytes: 65535 } }, err: /buffer\.maxBytes/ },
    { name: 'access ttl 60 ok', over: { cookie: { accessTtlSeconds: 60 } } },
    { name: 'access ttl 59 rejected', over: { cookie: { accessTtlSeconds: 59 } }, err: /cookie\.accessTtlSeconds/ },
    { name: 'access ttl 604800 ok', over: { cookie: { accessTtlSeconds: 604800 } } },
    { name: 'access ttl 604801 rejected', over: { cookie: { accessTtlSeconds: 604801 } }, err: /cookie\.accessTtlSeconds/ },
    { name: 'refresh ttl 60 ok', over: { cookie: { refreshTtlSeconds: 60 } } },
    { name: 'refresh ttl 59 rejected', over: { cookie: { refreshTtlSeconds: 59 } }, err: /cookie\.refreshTtlSeconds/ },
    { name: 'cookie name token ok', over: { cookie: { name: 'good_name-1' } } },
    { name: 'cookie name with space rejected', over: { cookie: { name: 'bad name' } }, err: /cookie\.name/ },
    { name: 'cookie name with semicolon rejected', over: { cookie: { name: 'has;semi' } }, err: /cookie\.name/ },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      writeConfig(c.over);
      if (c.err) assert.throws(() => loadConfig(), c.err);
      else assert.doesNotThrow(() => loadConfig());
    });
  }
});

test('loadState creates a missing state file and returns a null mode', () => {
  const p = path.join(dir, 'nested', 'state.json');
  assert.equal(existsSync(p), false);
  assert.deepEqual(loadState(p), { mode: null });
  assert.equal(existsSync(p), true);
});

test('loadState normalizes the mode enum', async (t) => {
  const cases = [
    { name: 'fast', raw: '{"mode":"fast"}', want: 'fast' },
    { name: 'soft', raw: '{"mode":"soft"}', want: 'soft' },
    { name: 'unknown mode -> null', raw: '{"mode":"bogus"}', want: null },
    { name: 'missing mode -> null', raw: '{"other":1}', want: null },
    { name: 'array -> null', raw: '[]', want: null },
    { name: 'null literal -> null', raw: 'null', want: null },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const p = path.join(dir, `state-${randomBytes(6).toString('hex')}.json`);
      writeFileSync(p, c.raw);
      assert.deepEqual(loadState(p), { mode: c.want });
    });
  }
});

test('loadState throws on malformed JSON', () => {
  const p = path.join(dir, `state-bad-${randomBytes(6).toString('hex')}.json`);
  writeFileSync(p, 'not json');
  assert.throws(() => loadState(p), /invalid JSON in state file/);
});

test('saveState round-trips through loadState and writes a 0600 file', () => {
  const p = path.join(dir, `state-save-${randomBytes(6).toString('hex')}.json`);
  saveState(p, { mode: 'fast' });
  assert.deepEqual(loadState(p), { mode: 'fast' });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});
