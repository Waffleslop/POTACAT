// Main window layout fixes (2026-11-10, Casey's go on the bug plan):
//   #285 the Hunter table's Log button read "L" after the Nets/SW page
//   #284 a net added from Directory > HF Nets showed only a check mark
//   #298 a long remote shack name pushed HOLD TO TALK off the screen
// Run: node test/main-window-layout-fixes-test.js
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}
const root = path.join(__dirname, '..');
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const css = readSrc(path.join(root, 'renderer', 'styles.css'));

console.log('Main window layout fixes');

test('#285: a hidden table (width 0) does not switch the table to compact', () => {
  const i = app.indexOf('function updateCompactMode(width) {');
  const body = app.slice(i, i + 500);
  assert.ok(/if \(!\(width > 0\)\) return;\s*\n\s*const compact = width < COMPACT_THRESHOLD;/.test(body));
});

test('#284: the HF Nets button column fits "Remove" and is never clipped; frequencies compare as text', () => {
  assert.ok(/\.dir-action-col \{ width: 84px; text-align: center; \}/.test(css));
  assert.ok(/\.directory-table tbody td\.dir-action-col \{ overflow: visible; text-overflow: clip; \}/.test(css));
  assert.ok(/r\.name === net\.name && String\(r\.frequency\) === String\(net\.frequency\)/.test(app));
  assert.ok(!/r\.name === net\.name && r\.frequency === net\.frequency/.test(app));
});

test('#298: only the shack chip shrinks, with "...", and its title carries the whole line', () => {
  assert.ok(/\.status-bar \{ min-width: 0; flex-shrink: 1; \}/.test(css));
  assert.ok(/\.status-bar > \* \{ flex: none; \}/.test(css));
  assert.ok(/\.status-bar > #remote-shack-status \{ flex: 0 1 auto; min-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/.test(css));
  assert.ok(/chip\.title = \(name \+ rig \+ leg \+ rtt \+ also \+ silent\) \+ '\\n' \+/.test(app));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/main-window-layout-fixes-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
