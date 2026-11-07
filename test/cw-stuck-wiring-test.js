// #127: main stops every CW backend when the controller reports a radio still
// keyed after a CW message, and says which path keyed the text.
//
// Run: node test/cw-stuck-wiring-test.js

'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const main = readSrc(path.join(__dirname, '..', 'main.js'));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + err.message); }
}

test('cw-stuck is wired to the same stop the phone STOP runs, and the key line drops', () => {
  const at = main.indexOf("controller.on('cw-stuck'");
  assert.ok(at > 0, "controller.on('cw-stuck') is wired");
  const body = main.slice(at, at + 1500);
  assert.ok(/cancelAllCwSends\(\)/.test(body), 'cancelAllCwSends()');
  assert.ok(/dropCwKeyLine\('CW stuck/.test(body), "dropCwKeyLine('CW stuck ...')");
  assert.ok(/\[CW\]/.test(body), 'a [CW] log line');
  assert.ok(/controller !== cat/.test(body) || /controller === cat/.test(body), 'only the live controller');
});

test('the CAT text path logs which command keyed the text', () => {
  const fn = main.slice(main.indexOf('function _sendCwTextToRadioImpl'), main.indexOf('function cancelAllCwSends'));
  assert.ok(/sendCatLog\(`\[CW\] Text via CAT /.test(fn), '[CW] Text via CAT ...');
});

console.log(`\nCW stuck wiring: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
