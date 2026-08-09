import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, resolveShell, resolveListen } from '../src/config.js';

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
  assert.equal(typeof cfg.terminal.cwd, 'string');
  assert.ok(cfg.terminal.cwd.length > 0);
  assert.equal(cfg.authFile, path.join(CONFIG_DIR, 'auth.json'));
});

test('loadConfig seeds a 0600 config.json from defaults when it is missing', () => {
  rmSync(configFile(), { force: true });
  assert.equal(existsSync(configFile()), false);
  const cfg = loadConfig();
  assert.equal(existsSync(configFile()), true);
  assert.equal(statSync(configFile()).mode & 0o777, 0o600);
  assert.equal(cfg.listen.port, 8442);
  assert.equal(cfg.authFile, path.join(CONFIG_DIR, 'auth.json'));
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

test('loadConfig resolves a relative authFile against the config dir', () => {
  writeConfig({ authFile: '../shared/creds.json' });
  const cfg = loadConfig();
  assert.equal(cfg.authFile, path.resolve(CONFIG_DIR, '../shared/creds.json'));
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
    { name: 'access ttl 60 ok', over: { cookie: { accessTtlSeconds: 60 } } },
    { name: 'access ttl 59 rejected', over: { cookie: { accessTtlSeconds: 59 } }, err: /cookie\.accessTtlSeconds/ },
    { name: 'access ttl 604800 ok', over: { cookie: { accessTtlSeconds: 604800 } } },
    { name: 'access ttl 604801 rejected', over: { cookie: { accessTtlSeconds: 604801 } }, err: /cookie\.accessTtlSeconds/ },
    { name: 'refresh ttl 60 ok', over: { cookie: { refreshTtlSeconds: 60 } } },
    { name: 'refresh ttl 59 rejected', over: { cookie: { refreshTtlSeconds: 59 } }, err: /cookie\.refreshTtlSeconds/ },
    { name: 'cookie name token ok', over: { cookie: { name: 'good_name-1' } } },
    { name: 'cookie name with space rejected', over: { cookie: { name: 'bad name' } }, err: /cookie\.name/ },
    { name: 'cookie name with semicolon rejected', over: { cookie: { name: 'has;semi' } }, err: /cookie\.name/ },
    // path.resolve throws a raw ERR_INVALID_ARG_TYPE on a non-string, so this must be caught by the validator first.
    { name: 'non-string authFile rejected', over: { authFile: 42 }, err: /authFile/ },
    { name: 'empty authFile rejected', over: { authFile: '  ' }, err: /authFile/ },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      writeConfig(c.over);
      if (c.err) assert.throws(() => loadConfig(), c.err);
      else assert.doesNotThrow(() => loadConfig());
    });
  }
});

test('resolveListen', () => {
  assert.deepEqual(resolveListen(':9000', '0.0.0.0'), { host: '0.0.0.0', port: 9000 });
  assert.deepEqual(resolveListen('[::]:9000'), { host: '::', port: 9000 });
  assert.throws(() => resolveListen('9000'), /--listen must be host:port/);
  assert.throws(() => resolveListen(':65536'), /--listen must be host:port/);
});

test('resolveShell', async (t) => {
  const cases = [
    { name: 'zsh', in: 'zsh', want: '/usr/bin/env zsh -l' },
    { name: 'bash', in: 'bash', want: '/usr/bin/env bash -l' },
    { name: 'fish', in: 'fish', want: '/usr/bin/env fish -l' },
    { name: 'unknown name rejected', in: 'bsh', err: /--shell must be one of/ },
    // `--shell ""` parses to an empty string, and a truthiness check would silently fall through to the default
    { name: 'empty string rejected', in: '', err: /--shell must be one of/ },
    { name: 'whitespace rejected', in: ' zsh', err: /--shell must be one of/ },
    { name: 'a path rejected', in: '/bin/bash', err: /--shell must be one of/ },
    { name: 'extra args rejected', in: 'bash -c evil', err: /--shell must be one of/ },
    { name: 'undefined rejected', in: undefined, err: /--shell must be one of/ },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      if (c.err) assert.throws(() => resolveShell(c.in), c.err);
      else assert.equal(resolveShell(c.in), c.want);
    });
  }
});
