// What a brand-new install starts with (Casey 2026-09-25): the charcoal dark
// theme, WSPR as the idle receive mode, and no ECHOCAT Web token. Installs
// that never chose keep what they have (navy, SSTV), so these live in the
// fresh-install settings, not in the read-side fallbacks.
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
const main = R('main.js');
const html = R('renderer/index.html');

test('fresh-install settings: charcoal and WSPR', () => {
  const load = main.slice(main.indexOf('function loadSettings()'), main.indexOf('function loadSettings()') + 1200);
  const fresh = (load.match(/return \{ grid: 'FN20jb'[^\n]*\};/) || [''])[0];
  assert.ok(/darkVariant: 'charcoal'/.test(fresh), fresh);
  assert.ok(/idleRxMode: 'wspr'/.test(fresh), fresh);
  assert.ok(!/remoteRequireToken/.test(fresh), 'a fresh install must not require an ECHOCAT token');
});

test('the first-run welcome screen shows WSPR before any setting is read', () => {
  const sel = html.slice(html.indexOf('<select id="welcome-idle-rx-mode"'), html.indexOf('</select>', html.indexOf('<select id="welcome-idle-rx-mode"')));
  assert.ok(/<option value="wspr" selected>WSPR<\/option>/.test(sel));
});

test('existing installs keep their look: the read-side fallback is still navy', () => {
  assert.ok(/settings\.darkVariant \|\| 'navy'/.test(main));
});

console.log(`\nFresh-install defaults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
