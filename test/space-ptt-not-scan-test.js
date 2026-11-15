'use strict';
// Space bar as "Hold a key to talk" (Settings > ECHOCAT) must only key:
// it never starts or stops scanning, and the release never clicks a
// focused button (dsnider, 2026-11-15). Source guard on renderer/app.js.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

test('the chosen PTT key is kept where the scan shortcut can see it', () => {
  assert.ok(/^let remoteShackPttKey = '';$/m.test(src), 'top-level remoteShackPttKey');
  assert.ok(/_pttKey = p\.pttKey \|\| '';\n\s*remoteShackPttKey = _pttKey;/.test(src), 'set with _pttKey');
});

test('every Space scan shortcut steps aside when Space is the PTT key', () => {
  const lines = src.split('\n').filter((l) => /e\.code === 'Space'/.test(l) && /scan|matches\('input/.test(l));
  assert.ok(lines.length >= 1, 'found the Space scan shortcut');
  for (const l of lines) assert.ok(/remoteShackPttKey !== 'Space'/.test(l), 'unguarded: ' + l.trim());
  const scanToggles = src.match(/if \(scanning\) \{ stopScan\(\); \} else \{ startScan\(\); \}/g) || [];
  assert.strictEqual(scanToggles.length, 1, 'one Space scan toggle');
});

test('releasing the PTT key cannot click a focused button', () => {
  assert.ok(/if \(!_pttKeyHeld \|\| e\.code !== _pttKey\) return;\n\s*e\.preventDefault\(\);/.test(src));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
