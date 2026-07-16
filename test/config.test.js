import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, loadState, saveState } from '../src/config.js';

let dir;
before(() => { dir = mkdtempSync(path.join(tmpdir(), 'rinnegan-config-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function writeConfig(value) {
  const p = path.join(dir, `cfg-${randomBytes(6).toString('hex')}.json`);
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
}

test('loadConfig fills defaults from a minimal config', () => {
  const cfg = loadConfig(writeConfig({}));
  assert.equal(cfg.listen.port, 8442);
  assert.equal(cfg.listen.host, '127.0.0.1');
  assert.equal(cfg.cookie.name, 'rinnegan');
  assert.equal(cfg.cookie.secure, false);
  assert.equal(cfg.cookie.ttlSeconds, 86400);
  assert.equal(cfg.terminal.cols, 120);
  assert.equal(cfg.terminal.env.TERM, 'xterm-256color');
  assert.equal(cfg.control.mode, 'soft');
  assert.equal(cfg.buffer.maxBytes, 2097152);
  assert.equal(typeof cfg.terminal.cwd, 'string');
  assert.ok(cfg.terminal.cwd.length > 0);
  assert.ok(path.isAbsolute(cfg.usersFile));
  assert.ok(path.isAbsolute(cfg.stateFile));
});

test('loadConfig deep-merges nested overrides while keeping sibling defaults', () => {
  const cfg = loadConfig(writeConfig({ cookie: { secure: true } }));
  assert.equal(cfg.cookie.secure, true);
  assert.equal(cfg.cookie.name, 'rinnegan');
  assert.equal(cfg.cookie.ttlSeconds, 86400);
});

test('loadConfig merges a deeply nested object keeping unmentioned keys', () => {
  const cfg = loadConfig(writeConfig({ terminal: { env: { TERM: 'screen-256color' } } }));
  assert.equal(cfg.terminal.env.TERM, 'screen-256color');
  assert.equal(cfg.terminal.env.COLORTERM, 'truecolor');
  assert.equal(cfg.terminal.env.LANG, 'en_US.UTF-8');
});

test('loadConfig treats an empty object override as no change', () => {
  const cfg = loadConfig(writeConfig({ terminal: {} }));
  assert.equal(cfg.terminal.shell, '/usr/bin/env zsh -l');
  assert.equal(cfg.terminal.rows, 36);
});

test('loadConfig keeps an explicit terminal.cwd override', () => {
  const cfg = loadConfig(writeConfig({ terminal: { cwd: '/tmp/somewhere' } }));
  assert.equal(cfg.terminal.cwd, '/tmp/somewhere');
});

test('loadConfig resolves relative users/state paths against the config directory', () => {
  const cfg = loadConfig(writeConfig({ usersFile: './creds.json', stateFile: '../shared/state.json' }));
  assert.equal(cfg.usersFile, path.resolve(dir, './creds.json'));
  assert.equal(cfg.stateFile, path.resolve(dir, '../shared/state.json'));
});

test('loadConfig ignores a __proto__ key without polluting Object.prototype', () => {
  const p = writeConfig('{"__proto__":{"polluted":true},"listen":{"port":9000}}');
  const cfg = loadConfig(p);
  assert.equal(cfg.listen.port, 9000);
  assert.equal({}.polluted, undefined);
});

test('loadConfig throws on unreadable, malformed, or non-object input', () => {
  assert.throws(() => loadConfig(path.join(dir, 'does-not-exist.json')), /cannot read config file/);
  assert.throws(() => loadConfig(writeConfig('{ not json')), /invalid JSON in config file/);
  assert.throws(() => loadConfig(writeConfig('[]')), /config must be a JSON object/);
  assert.throws(() => loadConfig(writeConfig('5')), /config must be a JSON object/);
  assert.throws(() => loadConfig(writeConfig({ listen: 5 })), /listen must be an object/);
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
    { name: 'ttl 60 ok', over: { cookie: { ttlSeconds: 60 } } },
    { name: 'ttl 59 rejected', over: { cookie: { ttlSeconds: 59 } }, err: /cookie\.ttlSeconds/ },
    { name: 'cookie name token ok', over: { cookie: { name: 'good_name-1' } } },
    { name: 'cookie name with space rejected', over: { cookie: { name: 'bad name' } }, err: /cookie\.name/ },
    { name: 'cookie name with semicolon rejected', over: { cookie: { name: 'has;semi' } }, err: /cookie\.name/ },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const p = writeConfig(c.over);
      if (c.err) assert.throws(() => loadConfig(p), c.err);
      else assert.doesNotThrow(() => loadConfig(p));
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
