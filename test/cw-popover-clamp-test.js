#!/usr/bin/env node
'use strict';
// N6UGP (1.11.8, macOS): the CW popover (Sidetone Vol / WPM) opened clipped
// off the right edge of the window and followed the edge as the window grew.
// Cause: CSS `right: 0` AND a JS `left` on the same absolutely positioned
// box — the box stretched from the CW button (at the bar's right end) to the
// bar's edge, then min-width pushed it 200 px past the window. The popover
// now right-aligns to the button and clamps inside the bar like the Rig one.
// Run: node test/cw-popover-clamp-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('CW popover stays inside the window');

test('CSS: .cw-popover no longer pins right: 0 (JS owns left)', () => {
  const css = R('renderer/styles.css');
  const block = css.slice(css.indexOf('.cw-popover {'), css.indexOf('.cw-popover.hidden'));
  assert.ok(!/^\s*right:\s*0;/m.test(block), 'right: 0 would stretch the box past the window');
  assert.ok(/position: absolute;/.test(block) && /min-width: 200px;/.test(block));
});

test('JS: right edge on the button, clamped to the status bar, measured while visible', () => {
  const app = R('renderer/app.js');
  const fn = app.slice(app.indexOf('function positionCwPopover()'), app.indexOf('function closeCwPopover()'));
  assert.ok(/const popW = cwPopover\.offsetWidth \|\| 200;/.test(fn));
  assert.ok(/let left = rect\.right - barRect\.left - popW;/.test(fn), 'right-aligned to the button');
  assert.ok(/if \(left \+ popW > barRect\.width\) left = Math\.max\(0, barRect\.width - popW\);/.test(fn), 'clamped');
  assert.ok(/cwPopover\.classList\.remove\('hidden'\);\n\s*positionCwPopover\(\);/.test(fn), 'unhidden before measuring');
  assert.ok(!/cwPopover\.style\.left = \(rect\.left - barRect\.left\)/.test(fn), 'old left-align gone');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
