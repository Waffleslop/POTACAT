#!/usr/bin/env node
'use strict';
// Every visible window has a minimum size (N0KAH 2026-10-24: the SSTV, VFO and
// main windows could be shrunk to bare window controls on a Mac). Hidden helper
// windows and offscreen renders are exempt.
// Run: node test/window-min-size-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
// Each BrowserWindow options block, up to its closing "});".
const blocks = [];
const re = /new BrowserWindow\(\{/g;
let m;
while ((m = re.exec(main))) blocks.push(main.slice(m.index, main.indexOf('});', m.index)));

console.log('Window minimum sizes');
test('every visible window declares minWidth and minHeight', () => {
  const missing = blocks.filter((b) => !/show:\s*false/.test(b) && !/offscreen:\s*true/.test(b) && !/minWidth:\s*\d+/.test(b));
  assert.deepStrictEqual(missing.map((b) => (b.match(/title:\s*([^,\n]+)/) || [, b.slice(0, 60)])[1]), []);
});
test('a minimum never exceeds the window\'s own opening size', () => {
  for (const b of blocks) {
    const mw = Number((b.match(/minWidth:\s*(\d+)/) || [])[1]);
    const w = Number((b.match(/\bwidth:\s*(\d+)/) || [])[1]);
    if (mw && w) assert.ok(mw <= w, `minWidth ${mw} > width ${w} in ${(b.match(/title:\s*([^,\n]+)/) || [])[1]}`);
    const mh = Number((b.match(/minHeight:\s*(\d+)/) || [])[1]);
    const h = Number((b.match(/\bheight:\s*(\d+)/) || [])[1]);
    if (mh && h) assert.ok(mh <= h, `minHeight ${mh} > height ${h} in ${(b.match(/title:\s*([^,\n]+)/) || [])[1]}`);
  }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
