// Discord report 2026-11-24 (artificialjumpprotection): on a narrow window the
// spot count at the end of the main status bar ran off the right edge, even with a
// short radio name. The bar may shrink (#298) but also wraps, so every chip stays
// inside the window and none is clipped.
// Run: node test/status-bar-wrap-test.js
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const css = readSrc(path.join(root, 'renderer', 'styles.css'));
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}
console.log('Status bar wrap');
const m = css.match(/^header \{([^}]*)\}/m);
test('the header wraps, so the status bar drops under the filters', () => {
  assert.ok(m, 'rule found');
  assert.ok(/flex-wrap:\s*wrap;/.test(m[1]), 'flex-wrap: wrap');
  assert.ok(/row-gap:\s*\d+px;/.test(m[1]), 'row-gap');
  assert.ok(/\.status-bar \{ margin-left: auto; \}/.test(css), 'bar stays right');
});
test('the shack chip still shrinks (#298)', () => {
  assert.ok(/\.status-bar \{ min-width: 0; flex-shrink: 1; \}/.test(css));
});
test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/status-bar-wrap-test.js'"));
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
