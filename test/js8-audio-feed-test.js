#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// JS8 must have someone capturing audio for it.
//
// KN4IIG, IC-7300 over rigctld, 1.10.21 (2026-09-20): "JS8 no decodes,
// waterfall black, FT8 works". JS8 runs as the JTCAT engine, but its window
// captures nothing; the FT8 pop-out feeds the engine from its own worklet and
// a phone-started session is fed by the main window — JS8's start paths asked
// nobody. On a USB-codec rig the engine ran deaf. On the Flex it was fed in
// main, so the desk it was built on never saw it.
//
// Run:  node test/js8-audio-feed-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
let pass = 0; let fail = 0; const failures = [];
function check(msg, fn) {
  try { fn(); pass++; } catch (err) { fail++; failures.push(msg); console.log(`  ✗ ${msg}\n      ${err.message}`); }
}
function fnBody(name) {
  const i = mainSrc.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} not found`);
  const j = mainSrc.indexOf('\nfunction ', i + 10);   // to the next top-level function
  return mainSrc.slice(i, j > 0 ? j : i + 60000);
}

check('a JS8 engine session asks the main window to capture, the way a phone start does', () => {
  const s = fnBody('startJtcat');
  const i = s.indexOf("if (ft8Engine._mode === 'JS8') js8AudioFeed(true);");
  assert.ok(i > 0, 'startJtcat does not call js8AudioFeed(true) for JS8');
});

check('js8AudioFeed uses the same channel as a phone start, and defers to an open FT8 pop-out', () => {
  const s = fnBody('js8AudioFeed');
  assert.ok(s.includes("'jtcat-start-for-remote'") && s.includes("'jtcat-stop-for-remote'"));
  assert.ok(/if \(on && jtcatPopoutWin && !jtcatPopoutWin\.isDestroyed\(\)\) return;/.test(s), 'must not double-capture while the pop-out feeds');
  assert.ok(s.includes("sendCatLog(`[JS8] audio:"), 'the bug report must show who is capturing');
});

check('stopping a JS8 session releases the main-window capture', () => {
  const s = fnBody('stopJtcat');
  assert.ok(s.includes("if (ft8Engine && ft8Engine._mode === 'JS8') js8AudioFeed(false);"));
});

check('closing the FT8 pop-out mid-JS8 hands the feed to the main window', () => {
  const i = mainSrc.indexOf("jtcatPopoutWin.on('closed', () => {");
  assert.ok(mainSrc.slice(i, i + 400).includes('if (js8Engine()) js8AudioFeed(true);'));
});

check('the renderer capture is still dropped where main feeds the engine itself (no double feed on Flex / K4 / Icom Network)', () => {
  const i = mainSrc.indexOf("ipcMain.on('jtcat-audio'");
  const s = mainSrc.slice(i, i + 1500);
  assert.ok(s.includes("if (settings.audioSource === 'smartsdr' && smartSdrAudio) return;"));
  assert.ok(/k4-network[\s\S]*return;/.test(s));
  assert.ok(/icom-network[\s\S]*return;/.test(s));
});

console.log('\n' + '='.repeat(52));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All tests passed.');
