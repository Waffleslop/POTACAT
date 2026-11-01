#!/usr/bin/env node
'use strict';
// Every window's preload exposes `window.api` through contextBridge, a
// global no classic script may redeclare: lib/jtcat-snr-floor.js had a
// top-level `const api`, a SyntaxError in the JTCAT window that dropped the
// whole file, so window.JtcatSnrFloor never existed there and the window's
// signal-floor boxes never saved (found 2026-11-02 by loading each window).
// Run: node test/renderer-global-api-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const renderer = path.join(__dirname, '..', 'renderer');
let checked = 0;
const bad = [];
for (const html of fs.readdirSync(renderer).filter((f) => f.endsWith('.html'))) {
  const src = fs.readFileSync(path.join(renderer, html), 'utf8');
  for (const m of src.matchAll(/<script src="([^"]+\.js)"/g)) {
    if (/node_modules/.test(m[1])) continue;
    const file = path.join(renderer, m[1]);
    if (!fs.existsSync(file)) continue;
    checked++;
    const js = fs.readFileSync(file, 'utf8');
    // Column 0 only: a declaration inside a function or an IIFE is scoped.
    if (/^(?:const|let|class)\s+api\b/m.test(js)) bad.push(`${html} -> ${m[1]}`);
  }
}
try {
  assert.ok(checked > 20, `only ${checked} scripts found`);
  assert.deepStrictEqual(bad, [], 'a top-level `api` declaration in a script a window loads: ' + bad.join(', '));
  console.log(`  ok  ${checked} window scripts, none redeclares the preload's global api`);
  console.log('\n1 passed, 0 failed');
} catch (e) {
  console.log('  FAIL ' + e.message);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}
