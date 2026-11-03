#!/usr/bin/env node
'use strict';
/**
 * Every pop-out follows a theme change, whichever control made it. A user
 * (2026-10-28): "I had just changed the table to dark mode and the VFO didn't
 * change with it, but the VFO changed to dark when I restarted." Saving the
 * theme in Settings skipped the VFO, Log, pairing and Band Scope windows;
 * only the quick toggle reached them.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const fn = app.slice(app.indexOf('function broadcastPopoutTheme('), app.indexOf('function _popoutThemePayload('));

check('one function sends the theme to every pop-out the main window can theme', () => {
  const senders = [...preload.matchAll(/^\s+(\w*[Pp]opoutTheme): \(theme\) => ipcRenderer\.send\('([a-z-]+)', theme\)/gm)]
    .map((m) => m[1]);
  assert.ok(senders.length >= 12, 'preload senders found: ' + senders.length);
  for (const s of senders) assert.ok(fn.includes('window.api.' + s + '('), s + ' is in broadcastPopoutTheme');
});
check('both the quick toggle and Settings > Save use it, and nothing sends window by window', () => {
  assert.strictEqual((app.match(/broadcastPopoutTheme\(/g) || []).length, 3, 'the definition + two callers');
  const outside = app.replace(fn, '');
  assert.ok(!/window\.api\.\w*[Pp]opoutTheme\(/.test(outside.replace(/function _popoutThemePayload[\s\S]*?\n\}/, '')), 'no stray per-window sends');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
