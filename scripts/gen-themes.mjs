// Regenerates the palette blocks at the top of public/styles.css from the kitty themes in Tanq16/cli-Productivity-Suite,
// so `cps theme <name>` and rinnegan's dropdown paint the same terminal.
//
//   node scripts/gen-themes.mjs <path-to-cps>/internal/configs/themes [css|html|audit]
//
// css   the :root[data-theme] blocks, to paste over the ones in public/styles.css
// html  the <option> list, to paste over the one in public/index.html
// audit contrast for every UI role in every theme (default)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.argv[2] ?? '.');
const MODE = process.argv[3] ?? 'audit';
const ORDER = [
  'mocha', 'latte', 'gruvbox-dark', 'gruvbox-light', 'dracula-dark', 'dracula-light',
  'tokyonight-dark', 'tokyonight-light', 'monokai-dark', 'monokai-light',
  'atom-one-dark', 'atom-one-light', 'everforest-dark', 'everforest-light', 'nord-dark',
];
const HUES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

const srgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const linz = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const unlin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const lum = (h) => { const [r, g, b] = srgb(h).map(linz); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function toLab(hex) {
  const [r, g, b] = srgb(hex).map(linz);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromLab([L, a, bb]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return '#' + [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(Math.min(1, Math.max(0, unlin(c))) * 255).toString(16).padStart(2, '0')).join('');
}
const shift = (hex, dL) => { const [L, a, b] = toLab(hex); return fromLab([Math.min(1, Math.max(0, L + dL)), a, b]); };
const chroma = (hex) => { const [, a, b] = toLab(hex); return Math.hypot(a, b); };
const hueOf = (hex) => { const [, a, b] = toLab(hex); return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360; };
const arc = (h, target) => { const d = Math.abs(h - target) % 360; return d > 180 ? 360 - d : d; };
const rgbaOf = (hex, a) => `rgba(${srgb(hex).map((c) => Math.round(c * 255)).join(', ')}, ${a})`;

function parse(slug) {
  const src = readFileSync(resolve(DIR, slug + '.kittyconf'), 'utf8');
  const k = new Map();
  for (const [, key, val] of src.matchAll(/^\s*([a-z0-9_]+)\s+(#[0-9a-fA-F]{6})\s*$/gm)) k.set(key, val.toLowerCase());
  k.set('name', src.match(/^## name:\s*(.+)$/m)[1].trim());
  return k;
}

const themes = ORDER.map((slug) => {
  const k = parse(slug);
  const bg = k.get('background');
  const fg = k.get('foreground');
  const light = lum(bg) > 0.5;
  const dir = light ? -1 : 1;
  const ansi = Object.fromEntries(HUES.flatMap((h, i) => [[h, k.get('color' + i)], ['bright-' + h, k.get('color' + (i + 8))]]));

  // kitty's tab tones are the theme's own recessed surfaces when they sit near the background, and something far heavier when they don't.
  const below = (x) => toLab(bg)[0] - toLab(x)[0];
  const [hi, lo] = [k.get('inactive_tab_background'), k.get('tab_bar_background')].sort((a, b) => lum(b) - lum(a));
  const onLadder = hi !== lo && below(hi) >= 0.012 && below(hi) <= 0.05 && below(lo) >= 0.03 && below(lo) <= 0.1;
  const surface = onLadder ? hi : shift(bg, -0.03);
  const inset = onLadder ? lo : shift(bg, -0.06);

  const best = (...c) => c.reduce((a, b) => (ratio(a, surface) >= ratio(b, surface) ? a : b));
  const sourced = (key, floor) => (ratio(k.get(key), surface) >= floor ? k.get(key) : null);
  // A status role wants the canonical hue, and reaches for the bright twin only when the normal one cannot be read on the panel.
  const status = (hue) => (ratio(ansi[hue], surface) >= 3 ? ansi[hue] : best(ansi[hue], ansi['bright-' + hue]));
  // kitty fills an active tab with the foreground in several themes: a fine tab, a useless accent.
  const accented = (key, fallback) => {
    const v = sourced(key, 3);
    return v && chroma(v) >= 0.045 && v !== fg ? v : fallback;
  };
  const nearestHue = (target, ...slots) => slots.map((s) => ansi[s])
    .sort((x, y) => (ratio(y, surface) >= 3) - (ratio(x, surface) >= 3) || arc(hueOf(x), target) - arc(hueOf(y), target))[0];

  const accent = accented('active_tab_background', nearestHue(320, 'magenta', 'bright-magenta', 'blue', 'bright-blue'));
  const warn = status('yellow');
  const err = status('red');
  // The stale link state sits between reconnecting and failed, so it takes whichever leftover red or yellow leans most orange.
  const alert = [ansi.red, ansi['bright-red'], ansi.yellow, ansi['bright-yellow']]
    .filter((c) => c !== warn && c !== err)
    .sort((x, y) => arc(hueOf(x), 55) - arc(hueOf(y), 55))[0] ?? warn;

  return {
    slug, name: k.get('name'), light,
    t: {
      bg, surface, inset, raised: shift(bg, dir * 0.085),
      border: sourced('inactive_border_color', 1.8) ?? shift(bg, dir * 0.24),
      fg, 'fg-muted': sourced('scrollbar_handle_color', 2.5) ?? shift(bg, dir * 0.37),
      accent,
      'accent-soft': accented('active_border_color', nearestHue(230, 'blue', 'bright-blue', 'cyan', 'bright-cyan')),
      'on-accent': ratio(k.get('active_tab_foreground'), accent) >= 4.5 ? k.get('active_tab_foreground')
        : (ratio(bg, accent) >= ratio(fg, accent) ? bg : fg),
      scrim: rgbaOf(inset, light ? '.86' : '.85'),
      ok: status('green'), warn, alert, err,
      info: nearestHue(250, 'blue', 'bright-blue', 'cyan', 'bright-cyan'),
      cursor: k.get('cursor'),
      selection: k.get('selection_background'),
      'on-selection': k.get('selection_foreground'),
      ...ansi,
    },
  };
});

if (MODE === 'css') {
  console.log(themes.map(({ slug, light, t }) => {
    const row = (keys) => '  ' + keys.map((n) => `--${n}: ${t[n]};`).join(' ');
    return [
      `:root[data-theme="${slug}"] {`,
      `  color-scheme: ${light ? 'light' : 'dark'};`,
      row(['bg', 'surface', 'inset', 'raised']),
      row(['border', 'fg', 'fg-muted']),
      row(['accent', 'accent-soft', 'on-accent', 'scrim']),
      row(['ok', 'warn', 'alert', 'err', 'info']),
      row(['cursor', 'selection', 'on-selection']),
      row(HUES),
      row(HUES.map((h) => 'bright-' + h)),
      '}',
    ].join('\n');
  }).join('\n\n'));
} else if (MODE === 'html') {
  for (const { slug, name } of themes) console.log(`        <option value="${slug}">${name}</option>`);
} else {
  console.table(themes.map(({ slug, light, t }) => ({
    slug, mode: light ? 'light' : 'dark',
    ansi: new Set([...HUES, ...HUES.map((h) => 'bright-' + h)].map((n) => t[n])).size,
    panels: new Set([t.bg, t.surface, t.inset, t.raised]).size,
    fgBg: +ratio(t.fg, t.bg).toFixed(2),
    fgSurface: +ratio(t.fg, t.surface).toFixed(2),
    fgRaised: +ratio(t.fg, t.raised).toFixed(2),
    muted: +ratio(t['fg-muted'], t.surface).toFixed(2),
    border: +ratio(t.border, t.surface).toFixed(2),
    accent: +ratio(t.accent, t.surface).toFixed(2),
    onAccent: +ratio(t['on-accent'], t.accent).toFixed(2),
    soft: +ratio(t['accent-soft'], t.surface).toFixed(2),
    ok: +ratio(t.ok, t.surface).toFixed(2), warn: +ratio(t.warn, t.surface).toFixed(2),
    alert: +ratio(t.alert, t.surface).toFixed(2), err: +ratio(t.err, t.surface).toFixed(2),
    info: +ratio(t.info, t.surface).toFixed(2),
    onSelection: +ratio(t['on-selection'], t.selection).toFixed(2),
  })));
}
