// Tests for the voice-macro slot-count logic in renderer/app.js.
//
// Users can grow the voice-macro list from a default of 8 up to 25 with a
// "+ Add macro" button (and shrink it with "− Remove last"). The number of
// editor rows shown is decided by effectiveVoiceMacroSlots(): it honors the
// user's saved visible count but never hides a slot that already has a
// recording or a label — so shrinking after recording into a high slot can't
// make that recording disappear.
//
// app.js is a renderer file (DOM at top level), so we can't require() it. We
// extract just the pure function's source and eval it — same approach as
// test/popout-theme-boot-test.js — so we test the REAL shipped code.
//
// Run: node test/voice-macros-test.js
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

// Pull the function body out of app.js by name. The function is self-contained
// (no closure deps), so evaluating its text gives us the exact shipped logic.
const m = src.match(/function effectiveVoiceMacroSlots\(savedSlots, filled, labels, max\) \{[\s\S]*?\n\}/);
if (!m) {
  console.error('FAIL: could not locate effectiveVoiceMacroSlots in renderer/app.js');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const effectiveVoiceMacroSlots = new Function(m[0] + '\nreturn effectiveVoiceMacroSlots;')();

const MAX = 25;
let passed = 0, failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log(`  ✗ FAIL: ${label} (got ${actual}, expected ${expected})`); }
}

console.log('=== default / clamping ===');
eq(effectiveVoiceMacroSlots(8, [], [], MAX), 8, 'default 8 with no content → 8 rows');
eq(effectiveVoiceMacroSlots(0, [], [], MAX), 1, 'saved 0 clamps up to 1');
eq(effectiveVoiceMacroSlots(-3, [], [], MAX), 1, 'negative clamps up to 1');
eq(effectiveVoiceMacroSlots(999, [], [], MAX), MAX, 'huge saved clamps down to max (25)');
eq(effectiveVoiceMacroSlots(undefined, [], [], MAX), 1, 'undefined saved → 1');

console.log('\n=== content never hidden ===');
eq(effectiveVoiceMacroSlots(8, [10], [], MAX), 11, 'recording in slot 10 with saved 8 → 11 rows (reveal it)');
eq(effectiveVoiceMacroSlots(8, [], labelsAt(12, 'DX'), MAX), 13, 'label in slot 12 with saved 8 → 13 rows');
eq(effectiveVoiceMacroSlots(3, [4, 7], [], MAX), 8, 'highest recording (7) wins over saved 3 → 8 rows');
eq(effectiveVoiceMacroSlots(8, [2], ['CQ', 'ID', '73'], MAX), 8, 'content within saved count → stays 8');
eq(effectiveVoiceMacroSlots(20, [23], [], MAX), 24, 'recording in slot 23 with saved 20 → 24 rows');
eq(effectiveVoiceMacroSlots(8, [24], [], MAX), MAX, 'recording in slot 24 → full 25 rows');

console.log('\n=== empty/blank labels do not count as content ===');
eq(effectiveVoiceMacroSlots(8, [], ['', '', '', '', '', '', '', '', '', '', ''], MAX), 8, 'blank labels past 8 do not force extra rows');
eq(effectiveVoiceMacroSlots(5, [], labelsAt(9, ''), MAX), 5, 'empty-string label in slot 9 → stays 5');

console.log('\n=== shrink-after-record protection ===');
// User grew to 12, recorded slot 11, then "Remove last" tries to drop to 11.
// Slot 11 has content, so it must remain visible.
eq(effectiveVoiceMacroSlots(11, [11], [], MAX), 12, 'cannot shrink below a recorded slot');

function labelsAt(idx, val) {
  const a = [];
  for (let i = 0; i <= idx; i++) a.push(i === idx ? val : '');
  return a;
}

console.log('=== main.js: a phone save or delete reaches every client (Casey 2026-10-25) ===');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const sync = main.slice(main.indexOf("remoteServer.on('voice-macro-sync'"), main.indexOf("remoteServer.on('voice-macro-delete'"));
  eq(/remoteServer\.sendToClient\(\{ type: 'voice-macro-sync', idx, label: l, audio: [^}]*hash: voiceMacroHash\(idx\) \}\)/.test(sync), true, 'a phone upload is echoed as voice-macro-sync with the hash (the uploader\'s confirmation)');
  const del = main.slice(main.indexOf("remoteServer.on('voice-macro-delete'"), main.indexOf("remoteServer.on('voice-macro-play'"));
  eq(/sendToClient\(\{ type: 'voice-macro-delete', idx \}\)/.test(del), true, 'a phone delete is pushed to the other clients');
  const play = main.slice(main.indexOf("remoteServer.on('voice-macro-play'"), main.indexOf("remoteServer.on('voice-macro-play'") + 400);
  eq(/idx >= VOICE_MACRO_MAX\) return;/.test(play), true, 'voice-macro-play accepts every one of the 25 slots');
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
