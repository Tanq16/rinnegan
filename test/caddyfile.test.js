import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCaddyfile } from '../src/server.js';

const TEMPLATE = fileURLToPath(new URL('../launcher/Caddyfile', import.meta.url));
const DOMAIN_SAMPLE = fileURLToPath(new URL('../launcher/Caddyfile.domain.example', import.meta.url));
const HOURS = { h: 1, d: 24 };
const toHours = (v) => Number(v.slice(0, -1)) * HOURS[v.slice(-1)];

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

test('bundled Caddyfile template', async (t) => {
  const template = readFileSync(TEMPLATE, 'utf8');

  await t.test('pins an explicit internal leaf lifetime on a named site block', () => {
    const leaf = template.match(/issuer internal \{\s*lifetime (\d+[hd])/);
    assert.notEqual(leaf, null, 'the internal issuer must pin a lifetime, not inherit the 12h default');
    assert.ok(toHours(leaf[1]) >= 168, `a leaf under a week still rotates often: got ${leaf[1]}`);
    assert.match(
      template,
      /https:\/\/localhost:8443 \{/,
      'the lifetime is only honored by a policy with a subject; a host-less block alone silently drops it'
    );
  });

  await t.test('keeps the intermediate longer than the leaf so the leaf is not clamped', () => {
    const leaf = template.match(/issuer internal \{\s*lifetime (\d+[hd])/)[1];
    const intermediate = template.match(/intermediate_lifetime (\d+[hd])/);
    assert.notEqual(intermediate, null, 'a leaf past the 7d default intermediate needs intermediate_lifetime raised');
    assert.ok(
      toHours(intermediate[1]) >= toHours(leaf),
      `intermediate ${intermediate[1]} must outlast leaf ${leaf} or Caddy clamps the leaf`
    );
  });
});

// bin/caddy is a stock build with no dns.providers linked in, so a sample naming a DNS solver would fail at Caddy startup for the user rather than here.
test('the shipped domain sample asks for nothing the bundled Caddy lacks', () => {
  const solver = readFileSync(DOMAIN_SAMPLE, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .find((line) => /^dns\s+\S/.test(line));
  assert.equal(solver, undefined, `a DNS-01 solver needs an xcaddy-built binary: ${solver}`);
});

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
