import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCaddyfile } from '../src/server.js';

let home, prevHome, configDir, runtime;
before(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(path.join(tmpdir(), 'rinnegan-caddy-'));
  process.env.HOME = home;
  configDir = path.join(home, '.config', 'rinnegan');
  mkdirSync(configDir, { recursive: true });
  runtime = path.join(configDir, 'Caddyfile');
});
after(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function makeRoot(template) {
  const root = mkdtempSync(path.join(tmpdir(), 'rinnegan-root-'));
  if (template !== null) writeFileSync(path.join(root, 'Caddyfile'), template);
  return root;
}

test('resolveCaddyfile returns an explicit --caddyfile that exists', () => {
  rmSync(runtime, { force: true });
  const root = makeRoot('template\n');
  const explicit = path.join(root, 'custom.caddy');
  writeFileSync(explicit, 'explicit\n');
  assert.equal(resolveCaddyfile(root, { caddyfile: explicit }), explicit);
  rmSync(root, { recursive: true, force: true });
});

test('resolveCaddyfile throws when an explicit --caddyfile is missing', () => {
  assert.throws(() => resolveCaddyfile(null, { caddyfile: path.join(home, 'nope.caddy') }), /Caddyfile/);
});

test('resolveCaddyfile seeds the runtime from the template when the runtime is absent', () => {
  rmSync(runtime, { force: true });
  const root = makeRoot('seed-template\n');
  assert.equal(resolveCaddyfile(root, {}), runtime);
  assert.equal(existsSync(runtime), true);
  assert.equal(readFileSync(runtime, 'utf8'), 'seed-template\n');
  rmSync(root, { recursive: true, force: true });
});

test('resolveCaddyfile throws when there is no runtime and no template', () => {
  rmSync(runtime, { force: true });
  assert.throws(() => resolveCaddyfile(null, {}), /Caddyfile/);
});

test('resolveCaddyfile --refresh-caddyfile overwrites an existing runtime from the template', () => {
  writeFileSync(runtime, 'old-runtime\n');
  const root = makeRoot('new-template\n');
  assert.equal(resolveCaddyfile(root, { 'refresh-caddyfile': true }), runtime);
  assert.equal(readFileSync(runtime, 'utf8'), 'new-template\n');
  rmSync(root, { recursive: true, force: true });
});

test('resolveCaddyfile --refresh-caddyfile with no template keeps the existing runtime', () => {
  writeFileSync(runtime, 'kept-runtime\n');
  assert.equal(resolveCaddyfile(null, { 'refresh-caddyfile': true }), runtime);
  assert.equal(readFileSync(runtime, 'utf8'), 'kept-runtime\n');
});
