// CW WPM auto-sync on the ECHOCAT web client (KE4WLE 2026-09-25): one press
// matches the tuned spot's speed once, a double press or a hold turns
// auto-sync on/off, and with it on the speed follows the tuned spot as the
// dial moves and the spot list refreshes. Source guards: the page is one
// IIFE with no module seams.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const js = R('renderer/remote.js');
const main = R('main.js');

test('the spot dedupe keeps an RBN/cluster WPM on a POTA survivor', () => {
  const d = main.slice(main.indexOf('function dedupeCrossSource('), main.indexOf('function sendMergedSpots('));
  assert.ok(/if \(s\.wpm && !survivor\.wpm\) survivor\.wpm = s\.wpm;/.test(d));
});

test('single press matches once; double press and hold toggle auto-sync', () => {
  const b = js.slice(js.indexOf('if (echoWpmSyncBtn) {'), js.indexOf('if (echoWpmSyncBtn) {') + 2000);
  assert.ok(/_syncHoldTimer = setTimeout\(function\(\) \{ _syncHeld = true; setCwAutoSync\(!cwAutoSync\); \}, 550\)/.test(b), 'hold toggles');
  assert.ok(/if \(_syncHeld\) \{ _syncHeld = false; return; \}/.test(b), 'a hold is not also a click');
  assert.ok(/if \(_syncClickTimer\) \{[\s\S]{0,260}setCwAutoSync\(!cwAutoSync\);/.test(b), 'second press toggles');
  assert.ok(/_syncClickTimer = setTimeout\(function\(\) \{[\s\S]{0,200}applySpotWpm\(\);/.test(b), 'single press matches once');
});

test('auto-sync follows the dial and the spot list, only in CW, and persists per device', () => {
  assert.ok(/currentFreqKhz = s\.freq \/ 1000;\n\s*if \(Math\.abs\(currentFreqKhz - prevFreqKhz\) > 0\.05 && typeof resolveEchoSpotWpm === 'function'\) resolveEchoSpotWpm\(\);/.test(js), 'dial');
  assert.ok(/spots = msg\.data \|\| \[\];\n\s*if \(typeof resolveEchoSpotWpm === 'function'\) resolveEchoSpotWpm\(\);/.test(js), 'spot refresh');
  assert.ok(/if \(cwAutoSync && echoSpotWpm && isCwModeNow\(\)\) applySpotWpm\(\);/.test(js), 'CW only');
  assert.ok(/localStorage\.setItem\('echoCwAutoSync'/.test(js));
});

test('with auto-sync on the button stays visible (it is the only off switch)', () => {
  assert.ok(/echoWpmSyncBtn\.classList\.toggle\('hidden', !differs && !cwAutoSync\);/.test(js));
});

console.log(`\nCW auto-sync: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
