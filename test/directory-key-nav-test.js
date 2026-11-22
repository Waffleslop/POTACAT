'use strict';
// #501: Directory > Nets / Broadcast / Landmarks / Channels arrow keys move
// from the row the operator clicked, not from the last row the arrows reached.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Nav = require('../lib/directory-key-nav');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

test('after a click on row 5, Down goes to row 6 and Up to row 4', () => {
  // The arrows had reached row 12 before the click (the issue's marine channel).
  let s = Nav.step(Nav.initial(), 'channels', 20, -1, 1);
  for (let i = 0; i < 12; i++) s = Nav.step(s, 'channels', 20, -1, 1);
  assert.strictEqual(s.idx, 12);
  const clicked = Nav.clickAt(s, 'channels', 5);
  assert.strictEqual(Nav.step(clicked, 'channels', 20, -1, 1).idx, 6);
  assert.strictEqual(Nav.step(clicked, 'channels', 20, -1, -1).idx, 4);
});

test('a click works the same on every tab', () => {
  for (const tab of ['nets', 'swl', 'landmarks', 'channels']) {
    const s = Nav.clickAt(Nav.step(Nav.initial(), tab, 10, -1, 1), tab, 5);
    assert.deepStrictEqual(Nav.step(s, tab, 10, -1, 1), { tab, idx: 6 });
  }
});

test('the click wins over a stale tuned highlight', () => {
  // Nets/Broadcast mark a row tuned only when the radio echoes the frequency.
  const s = Nav.clickAt(Nav.initial(), 'nets', 5);
  assert.strictEqual(Nav.step(s, 'nets', 10, 8, 1).idx, 6);
});

test('a click off the rows (header) leaves the position alone', () => {
  const s = Nav.clickAt(Nav.initial(), 'nets', 3);
  assert.deepStrictEqual(Nav.clickAt(s, 'nets', -1), s);
});

test('the ends clamp', () => {
  const first = Nav.clickAt(Nav.initial(), 'landmarks', 0);
  assert.strictEqual(Nav.step(first, 'landmarks', 10, -1, -1).idx, 0);
  const last = Nav.clickAt(Nav.initial(), 'landmarks', 9);
  assert.strictEqual(Nav.step(last, 'landmarks', 10, -1, 1).idx, 9);
  // A remembered row past the end (the list shrank under a filter) starts over.
  const gone = Nav.clickAt(Nav.initial(), 'landmarks', 15);
  assert.strictEqual(Nav.step(gone, 'landmarks', 10, -1, 1).idx, 0);
  assert.strictEqual(Nav.step(Nav.initial(), 'landmarks', 0, -1, 1).idx, -1);
});

test('with no position, Down starts at the top and Up at the bottom, or from the selected row', () => {
  assert.strictEqual(Nav.step(Nav.initial(), 'nets', 10, -1, 1).idx, 0);
  assert.strictEqual(Nav.step(Nav.initial(), 'nets', 10, -1, -1).idx, 9);
  assert.strictEqual(Nav.step(Nav.initial(), 'nets', 10, 4, 1).idx, 5);
});

test('switching tabs resets the position', () => {
  const nets = Nav.clickAt(Nav.initial(), 'nets', 5);
  const swl = Nav.step(nets, 'swl', 10, -1, 1);
  assert.deepStrictEqual(swl, { tab: 'swl', idx: 0 });
  // and back again: Nets starts over too, it does not resume at row 5
  assert.deepStrictEqual(Nav.step(swl, 'nets', 10, -1, 1), { tab: 'nets', idx: 0 });
});

test('wiring: the renderer loads the module, steps through it and records clicks', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.ok(html.indexOf('../lib/directory-key-nav.js') > 0 && html.indexOf('../lib/directory-key-nav.js') < html.indexOf('src="app.js"'));
  assert.ok(/DirKeyNav\.step\(_dirKeyNav, dirvActiveTab, rows\.length/.test(app));
  assert.ok(/getElementById\('directory-view'\)[\s\S]{0,200}addEventListener\('click'[\s\S]{0,300}DirKeyNav\.clickAt\(_dirKeyNav, dirvActiveTab, directoryRows\(\)\.indexOf\(tr\)\)[\s\S]{0,20}\}, true\);/.test(app));
  assert.ok(/row\.scrollIntoView\(\{ block: 'nearest' \}\)/.test(app));
});

console.log(`directory-key-nav: ${passed} passed`);
