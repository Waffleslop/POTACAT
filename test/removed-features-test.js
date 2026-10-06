#!/usr/bin/env node
'use strict';
/**
 * Features Casey has retired stay retired. A removed integration tends to
 * creep back through a settings-blob key, a welcome-screen checkbox or a
 * forwarding branch nobody re-read; one grep per feature here keeps the
 * startup/welcome screen, Settings and the forwarding paths honest.
 *
 * - FT8 Battle Royale (removed 2026-10-06: "no longer something that is
 *   active"). It lived in the welcome screen (opt-in checkbox, default ON),
 *   Settings > Logbook (host/port/comment), the JTCAT panel (BR: comment
 *   field) and a per-QSO UDP fan-out in main.js.
 *
 * Run: node test/removed-features-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
const root = path.join(__dirname, '..');
const FILES = ['main.js', 'preload.js', 'renderer/app.js', 'renderer/index.html', 'renderer/remote.js', 'renderer/remote.html', 'lib/echocat-protocol.js'];
console.log('Removed features stay removed');

test('FT8 Battle Royale is gone from the app, the welcome screen, Settings and the wire', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const m = src.match(/battle\s*royale|ft8br/i);
    assert.ok(!m, `${f} still mentions it: "${m && m[0]}"`);
  }
});

console.log(`\nRemoved features: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
