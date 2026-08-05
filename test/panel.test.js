import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

function stageMarkup(html) {
  const start = html.indexOf('<div id="stage"');
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m; (m = tag.exec(html));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.lastIndex);
  }
  return html.slice(start);
}

test('every overlay stays outside #stage', async (t) => {
  const stage = stageMarkup(HTML);
  assert.ok(stage.includes('id="terminal"'), 'the #stage scan found no terminal, so it did not match the real element');

  for (const id of ['panel', 'control-toggle', 'upload-modal', 'exit-card', 'transfer-indicator', 'transfer-notice']) {
    await t.test(`#${id}`, () => {
      assert.ok(!stage.includes(`id="${id}"`),
        `#${id} nested in #stage would put its clicks through the stage handler, collapsing the control panel underneath it`);
    });
  }
});
