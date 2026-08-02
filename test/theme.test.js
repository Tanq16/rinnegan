import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (f) => readFileSync(fileURLToPath(new URL('../public/' + f, import.meta.url)), 'utf8');
const CSS = read('styles.css');
const HTML = read('index.html');
const LOGIN = read('login.html');
const APP = read('app.js');

const DEFAULT_THEME = 'mocha';
// The tokens public/app.js reads out of the computed style to build the xterm palette; a missing one reaches xterm as ''.
const ANSI_HUES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const TERMINAL_TOKENS = [
  '--bg', '--fg', '--cursor', '--selection', '--on-selection',
  ...ANSI_HUES.map((c) => '--' + c), ...ANSI_HUES.map((c) => '--bright-' + c),
];

const themes = new Map();
for (const [, name, body] of CSS.matchAll(/\[data-theme="([a-z-]+)"\][^{]*\{([^}]*)\}/g)) {
  themes.set(name, { tokens: new Set(body.match(/--[a-z-]+(?=\s*:)/g) ?? []), body });
}

const options = [...HTML.matchAll(/<option value="([a-z-]+)">/g)].map((m) => m[1]);

test('theme palettes', async (t) => {
  await t.test('the default theme block is present and non-trivial', () => {
    assert.ok(themes.has(DEFAULT_THEME), `no [data-theme="${DEFAULT_THEME}"] block in styles.css`);
    assert.ok(themes.get(DEFAULT_THEME).tokens.size > 20, 'the default block should carry the full palette');
  });

  const base = themes.get(DEFAULT_THEME).tokens;

  await t.test('every theme declares exactly the default theme\'s tokens', () => {
    for (const [name, { tokens }] of themes) {
      const missing = [...base].filter((v) => !tokens.has(v));
      const extra = [...tokens].filter((v) => !base.has(v));
      assert.deepEqual(missing, [], `${name} is missing ${missing.join(', ')} and would inherit ${DEFAULT_THEME}'s`);
      assert.deepEqual(extra, [], `${name} declares ${extra.join(', ')} that no other theme does`);
    }
  });

  await t.test('every theme sets color-scheme so native controls follow it', () => {
    for (const [name, { body }] of themes) {
      assert.match(body, /color-scheme:\s*(light|dark)\s*;/, `${name} does not set color-scheme`);
    }
  });

  await t.test('every token the terminal palette reads is declared', () => {
    for (const token of TERMINAL_TOKENS) {
      assert.ok(base.has(token), `app.js reads ${token} but no theme declares it`);
    }
  });

  await t.test('every var() referenced in a rule is declared', () => {
    const used = new Set([...CSS.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]));
    const undeclared = [...used].filter((v) => !base.has(v));
    assert.deepEqual(undeclared, [], `styles.css references undeclared ${undeclared.join(', ')}`);
  });

  await t.test('the control panel offers exactly the themes that exist', () => {
    assert.deepEqual([...options].sort(), [...themes.keys()].sort());
  });

  // app.js and the two inline bootstraps each carry their own copy of the key and the default; a divergence silently drops the stored theme on every reload.
  await t.test('the storage key and default theme agree across app.js and both bootstraps', () => {
    const key = APP.match(/const THEME_KEY = '([^']+)'/)?.[1];
    const fallback = APP.match(/const DEFAULT_THEME = '([^']+)'/)?.[1];
    assert.ok(key && fallback, 'app.js must declare THEME_KEY and DEFAULT_THEME');
    assert.ok(themes.has(fallback), `DEFAULT_THEME is ${fallback}, which has no theme block`);
    const bootstrap = new RegExp(`getItem\\('${key.replace(/\./g, '\\.')}'\\)\\s*\\|\\|\\s*'${fallback}'`);
    for (const [name, src] of [['index.html', HTML], ['login.html', LOGIN]]) {
      assert.match(src, bootstrap, `the ${name} bootstrap does not read '${key}' with a '${fallback}' fallback`);
    }
  });
});
