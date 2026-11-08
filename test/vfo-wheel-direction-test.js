// #192 w0tlp: the VFO window's mouse wheel tuned backwards. The radio and
// logger convention: wheel up (deltaY < 0) = frequency up.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/wheel-tune');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n    ' + e.message); }
}

test('wheel up (deltaY < 0) steps the frequency up', () => {
  assert.strictEqual(W.wheelDir(-100), 1);
  assert.strictEqual(W.wheelDir(-1), 1);
});
test('wheel down (deltaY > 0) steps the frequency down', () => {
  assert.strictEqual(W.wheelDir(100), -1);
  assert.strictEqual(W.wheelDir(3), -1);
});
test('no vertical movement (sideways scroll) does not tune', () => {
  assert.strictEqual(W.wheelDir(0), 0);
  assert.strictEqual(W.wheelDir(NaN), 0);
  assert.strictEqual(W.wheelDir(undefined), 0);
});
test('the VFO window wheel handler uses the shared direction', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'), 'utf8');
  assert.ok(html.includes('../lib/wheel-tune.js'), 'vfo-popout loads lib/wheel-tune.js');
  const m = /function handleFreqWheel\(e\) \{([\s\S]*?)\n\}/.exec(html);
  assert.ok(m, 'handleFreqWheel found');
  assert.ok(/WheelTune\.wheelDir\(e\.deltaY\)/.test(m[1]), 'direction comes from WheelTune.wheelDir');
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
