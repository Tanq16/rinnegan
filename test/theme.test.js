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
const ANSI_SLOTS = [...ANSI_HUES.map((c) => '--' + c), ...ANSI_HUES.map((c) => '--bright-' + c)];
const TERMINAL_TOKENS = ['--bg', '--fg', '--cursor', '--selection', '--on-selection', ...ANSI_SLOTS];

const themes = new Map();
for (const [, name, body] of CSS.matchAll(/\[data-theme="([a-z-]+)"\][^{]*\{([^}]*)\}/g)) {
  const values = new Map([...body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map(([, k, val]) => [k, val.trim()]));
  themes.set(name, { tokens: new Set(values.keys()), values, body });
}

const options = [...HTML.matchAll(/<option value="([a-z-]+)">/g)].map((m) => m[1]);

const luminance = (hex) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

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

  // A light palette that declares itself dark leaves the browser drawing dark scrollbars and form widgets over it.
  await t.test('every theme declares the color-scheme its background actually is', () => {
    for (const [name, { body, values }] of themes) {
      const declared = body.match(/color-scheme:\s*(light|dark)\s*;/)?.[1];
      assert.ok(declared, `${name} does not declare a color-scheme`);
      assert.equal(declared, luminance(values.get('--bg')) > 0.5 ? 'light' : 'dark', `${name} declares color-scheme: ${declared}`);
    }
  });

  // The nvim and tmux configs in cli-Productivity-Suite name literal indices with no light/dark branching, which only works while the greys stay in this order.
  await t.test('the grey rail runs from the background side to the foreground side', () => {
    for (const [name, { values }] of themes) {
      const rail = ['--black', '--bright-black', '--white', '--bright-white'].map((slot) => ({ slot, l: luminance(values.get(slot)) }));
      const toward = luminance(values.get('--fg')) - luminance(values.get('--bg'));
      for (let i = 1; i < rail.length; i++) {
        assert.ok(Math.sign(rail[i].l - rail[i - 1].l) === Math.sign(toward),
          `${name} puts ${rail[i].slot} on the wrong side of ${rail[i - 1].slot}`);
      }
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
