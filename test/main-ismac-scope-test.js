#!/usr/bin/env node
'use strict';
// K3SBP 2026-11-21: "ReferenceError: isMac is not defined" at main.js, opening
// the APRS window (#869 used isMac in three pop-out openers where no isMac was
// declared; every OS crashed). main.js has no file-wide isMac: each function
// declares its own. Every use must have a `const isMac` between the start of
// its handler or function and the use.
// Run: node test/main-ismac-scope-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const lines = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').split(/\r?\n/);
const START = /^\s{0,4}(ipcMain\.(on|handle)\(|(async )?function [\w$]+\s*\(|app\.(whenReady|on)\()/;
const DECL = /\b(const|let|var)\s+isMac\b/;
const bad = [];
let fileWide = false;
lines.forEach((l, i) => { if (/^(const|let|var)\s+isMac\b/.test(l)) fileWide = true; });
if (!fileWide) {
  lines.forEach((l, i) => {
    if (!/\bisMac\b/.test(l) || DECL.test(l) || /^\s*\/\//.test(l)) return;
    let ok = false;
    for (let j = i - 1; j >= 0; j--) {
      if (DECL.test(lines[j])) { ok = true; break; }
      if (START.test(lines[j])) break;
    }
    if (!ok) bad.push(`main.js:${i + 1}: ${l.trim().slice(0, 100)}`);
  });
}
try {
  assert.deepStrictEqual(bad, [], 'isMac used with no declaration in its function:\n  ' + bad.join('\n  '));
  console.log('  ok  every isMac in main.js is declared in its own function');
  console.log('\n1 passed, 0 failed');
} catch (e) {
  console.log('  FAIL ' + e.message);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}
