#!/usr/bin/env node
'use strict';
// What's New rendering (lib/release-notes-format.js). The 1.10.23 notes
// showed `\*` and `<sub>` as literal text in the dialog. Run:
// node test/release-notes-format-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { formatReleaseNotes: f } = require('../lib/release-notes-format');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const text = (html) => html.replace(/<[^>]+>/g, '');

console.log('release notes format');

test('the 1.10.23 opening renders: bold, literal asterisk, real <sub>', () => {
  const html = f("🍺 **Free beer at Dan WD4DAN's QTH!\\***\n\n<sub>\\* It's White Claw. It's his favorite.</sub>\n\nWe asked on Discord.");
  assert.ok(html.includes("<strong>Free beer at Dan WD4DAN's QTH!*</strong>"), html);
  assert.ok(html.includes("<sub>* It's White Claw. It's his favorite.</sub>"), html);
  assert.ok(!/\\/.test(html), 'no backslash left: ' + html);
  assert.ok(!/&lt;|\*\*/.test(html), 'no escaped tag or raw ** left: ' + html);
});

test('the shipped v1.10.23 notes leave no markdown or escaped tags on screen', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'release-notes', 'v1.10.23.md'), 'utf8');
  const html = f(md);
  const shown = text(html);
  assert.ok(!/\\[*_<>]/.test(shown), 'backslash escape visible');
  assert.ok(!/\*\*/.test(shown), 'raw ** visible');
  assert.ok(!/&lt;\/?(sub|sup|br|small|kbd)/.test(html), 'allowed tag escaped');
});

test('any other HTML stays escaped (no script, no attributes)', () => {
  const html = f('<script>alert(1)</script> <img src=x onerror=1> <sub onclick="x">a</sub>');
  assert.ok(!/<script|<img|<sub onclick/i.test(html), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
});

test('inline code keeps backslashes and asterisks verbatim', () => {
  const html = f('Use `send_cmd \\0xFE` and `**not bold**`.');
  assert.ok(html.includes('<code class="rn-code">send_cmd \\0xFE</code>'), html);
  assert.ok(html.includes('<code class="rn-code">**not bold**</code>'), html);
});

test('snake_case words are not italicised; links are http(s) only', () => {
  const html = f('Set jtcat_tx_gain and _this_. [ok](https://potacat.com) [bad](javascript:alert(1))');
  assert.ok(html.includes('jtcat_tx_gain'), html);
  assert.ok(html.includes('<em>this</em>'), html);
  assert.ok(html.includes('<a href="https://potacat.com"'), html);
  assert.ok(!/href="javascript/i.test(html), html);
});

test('CRLF bodies (GitHub API) still form paragraphs and lists', () => {
  const html = f('Para one.\r\n\r\n- a\r\n- b\r\n');
  assert.ok(html.includes('<p class="rn-p">Para one.</p>'), html);
  assert.ok(html.includes('<ul class="rn-ul"><li>a</li><li>b</li></ul>'), html);
});

test('the renderer loads the module and app.js delegates to it', () => {
  const root = path.join(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.ok(index.includes('<script src="../lib/release-notes-format.js"></script>'));
  assert.ok(/window\.ReleaseNotesFormat\.formatReleaseNotes\(md\)/.test(app));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
