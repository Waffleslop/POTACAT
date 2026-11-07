#!/usr/bin/env node
'use strict';
// GitHub #187 (NA4DQ, IC-7300, ARDOP): a Winlink session holds the DATA mode
// from its QSY to its end, and the dial goes back once, to exactly where the
// operator was, with a log line that says so.
//
// Before: an Icom reports USB + a separate DATA flag, so every ARDOP frame
// logged "[PTT] USB -> DIGU", waited ~135 ms for the DATA report, and after
// the unkey "Restoring USB mode" turned DATA off again: 20 mode commands for
// the ten ConReq frames of one attempt, and the session's own DIGU undone
// after the first.
// Run: node test/winlink-data-hold-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const S = require('../lib/ptt-mode-swap');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js'));
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0, j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

console.log('the plan for one key-down');
test('a Winlink frame with the radio already in DATA keys with no mode change and no restore', () => {
  assert.strictEqual(typeof S.sessionDataPlan, 'function', 'sessionDataPlan exists');
  assert.strictEqual(S.sessionDataPlan({ hold: true, inData: true }), 'keep');
});
test('a Winlink frame with DATA off switches once and holds it (no per-over restore)', () => {
  assert.strictEqual(S.sessionDataPlan({ hold: true, inData: false }), 'switch-hold');
});
test('anything else keeps the per-over swap (SSB-over-DATA voice, SSTV)', () => {
  assert.strictEqual(S.sessionDataPlan({ hold: false, inData: false }), 'switch-restore');
  assert.strictEqual(S.sessionDataPlan({ hold: false, inData: true }), 'switch-restore');
  assert.strictEqual(S.sessionDataPlan({}), 'switch-restore');
});

// A fake IC-7300: base mode USB, DATA as its own flag. Each key-down asks the
// plan; a switch sets DATA on; a per-over restore sets it off at the release.
function replay(bursts, { hold, dataAtStart }) {
  let data = dataAtStart;
  const cmds = [];
  for (let i = 0; i < bursts; i++) {
    const plan = S.sessionDataPlan({ hold, inData: data });
    if (plan !== 'keep') { cmds.push('DIGU'); data = true; }
    // ... the frame goes out, the modem unkeys ...
    if (plan === 'switch-restore') { cmds.push('USB'); data = false; }
  }
  return cmds;
}
test('replay of the 15:49:40-15:50:16 attempt (ten ConReq2000M): no mode command at all', () => {
  assert.deepStrictEqual(replay(10, { hold: true, dataAtStart: true }), []);
});
test('the same attempt before the fix: 20 mode commands (USB -> DIGU, Restoring USB) — the log', () => {
  assert.strictEqual(replay(10, { hold: false, dataAtStart: true }).length, 20);
});
test('the session tune\'s DATA frame lost: one switch on the first frame, then held', () => {
  assert.deepStrictEqual(replay(10, { hold: true, dataAtStart: false }), ['DIGU']);
});

console.log('the mode to come back to');
test('an Icom in DATA comes back in DATA: USB-D is DIGU, not USB', () => {
  assert.strictEqual(typeof S.dataFormOf, 'function', 'dataFormOf exists');
  assert.strictEqual(S.dataFormOf('USB'), 'DIGU');
  assert.strictEqual(S.dataFormOf('usb'), 'DIGU');
  assert.strictEqual(S.dataFormOf('LSB'), 'DIGL');
  assert.strictEqual(S.dataFormOf('FM'), 'DIGFM');
  assert.strictEqual(S.dataFormOf('AM'), 'DIGAM');
});
test('a mode with no data form, or one already in it, is unchanged', () => {
  for (const m of ['DIGU', 'DIGL', 'CW', 'RTTY', '']) assert.strictEqual(S.dataFormOf(m), m);
});

console.log('main.js wiring');
const ptt = fnBody(main, 'handleRemotePtt');
test('handleRemotePtt asks the plan for a Winlink key-down, judged on the radio\'s DATA report', () => {
  assert.ok(/const _holdData = forceData && opts\.txKind === 'winlink';/.test(ptt), 'hold = a forced-DATA Winlink frame');
  assert.ok(/PttModeSwap\.sessionDataPlan\(\{ hold: _holdData, inData: [^}]*pttModeReport\(\)/.test(ptt), 'judged on pttModeReport()');
});
test('a frame with the radio in DATA keys straight away, logged once per session', () => {
  assert.ok(/_dataPlan === 'keep'/.test(ptt));
  assert.ok(/keying without a mode change; it stays in DATA until the Winlink session ends/.test(ptt));
  assert.ok(/_pttDataHeldLoggedFor !== _winlinkSessionSeq/.test(ptt), 'once per session');
});
test('a held switch arms no per-over restore and no 120 s broadcast hold', () => {
  assert.ok(/_ssbModeBeforePtt = _dataPlan === 'switch-hold' \? null : curMode;/.test(ptt));
  assert.ok(/_modeSuppressUntil = Date\.now\(\) \+ \(_dataPlan === 'switch-hold' \? 2000 : 120000\);/.test(ptt));
  assert.ok(/held until the Winlink session ends/.test(ptt));
});
test('both return-to captures fold the DATA flag in (winlinkDialHere)', () => {
  const here = fnBody(main, 'winlinkDialHere');
  assert.ok(/PttModeSwap\.dataFormOf\(/.test(here) && /pttModeReport\(\)/.test(here));
  assert.ok(/_winlinkPreviewReturnTo = winlinkDialHere\('before the gateway pick'\)/.test(fnBody(main, 'winlinkPreviewQsy')));
  assert.ok(/returnTo: radio \? \(_winlinkPreviewReturnTo \|\| winlinkDialHere\('at Connect'\)\)/.test(fnBody(main, 'winlinkStartSession')));
});
test('session start says where the radio goes back to', () => {
  assert.ok(/the radio goes back to \$\{winlinkDialText\(/.test(fnBody(main, 'winlinkStartSession')));
});
test('the restore says where it goes, and never lands under a newer session', () => {
  const r = fnBody(main, 'winlinkRestoreDial');
  assert.ok(/if \(winlinkSessionActive\(\)\) \{/.test(r), 'refuses while a session runs');
  assert.ok(/session over: the radio goes back to \$\{winlinkDialText\(returnTo\)\}/.test(r));
  assert.ok(r.indexOf('if (winlinkSessionActive())') < r.indexOf('tuneRadio('), 'checked before the tune');
});

console.log(`\nWinlink DATA hold (#187): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
