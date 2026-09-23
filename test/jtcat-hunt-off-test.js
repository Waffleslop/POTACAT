#!/usr/bin/env node
'use strict';
// "Hunt: Off" is the finish-this-QSO-then-stop control (N2FSM 2026-08-31).
//
// Asked how to let the current QSO complete without starting another, an
// operator's only visible options were TX ON/OFF and Halt TX — both of which
// cut the exchange mid-stream. The control already exists: selecting Off stops
// NEW QSOs while the one in progress runs to its 73 and gets logged. That
// behaviour is emergent from two separate guards, so it is easy to break
// without noticing, and if it breaks the advice we gave every operator becomes
// wrong. These assertions pin both halves.
// Run: node test/jtcat-hunt-off-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('nothing NEW starts while hunt is off', () => {
  // The caller-selection block — CQ hunting AND answering a direct caller —
  // must sit behind the mode check, or "Off" would keep taking new QSOs.
  assert.ok(/if \(jtcatAutoCqMode !== 'off' && !popoutJtcatQso && !remoteJtcatQso\) \{/.test(MAIN),
    'the auto-CQ response guard changed shape');
});

test('answering a DIRECT caller is inside that same guard', () => {
  const guard = MAIN.indexOf("if (jtcatAutoCqMode !== 'off' && !popoutJtcatQso && !remoteJtcatQso) {");
  assert.notStrictEqual(guard, -1);
  const call = MAIN.indexOf('jtcatTryAnswerDirectCaller(results, myCall, myGrid)', guard);
  assert.notStrictEqual(call, -1, 'direct-caller answering moved out of the guard');
  // Crude but sufficient: it must appear within the guarded block, well before
  // the next top-level function.
  assert.ok(call - guard < 2000,
    'direct-caller answering is no longer inside the hunt-mode guard — Off would still take callers');
});

test('a QSO in progress keeps advancing regardless of hunt mode', () => {
  // This is the half that makes Off a graceful stop rather than an abort.
  for (const fn of ['processPopoutJtcatQso', 'processRemoteJtcatQso']) {
    const at = MAIN.indexOf('function ' + fn + '(results)');
    assert.notStrictEqual(at, -1, fn + ' not found');
    const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
    assert.ok(/_autoSeqEnabled\(\)/.test(body), fn + ' lost its auto-seq gate');
    assert.ok(!/jtcatAutoCqMode/.test(body),
      fn + ' now checks the hunt mode — turning Hunt off would ABANDON the QSO in progress');
  }
});

test('choosing Off mid-QSO says what it is about to do', () => {
  const at = MAIN.indexOf('function setJtcatHuntMode(');
  assert.notStrictEqual(at, -1);
  const body = MAIN.slice(at, at + 2000);
  assert.ok(/popoutJtcatQso \|\| remoteJtcatQso/.test(body),
    'no check for a QSO in progress when switching Off');
  assert.ok(/finishing the QSO in progress/.test(body),
    'the operator is not told the QSO will complete');
  assert.ok(/Halt TX/.test(body),
    'the message does not distinguish itself from the control that cuts the QSO');
});

test('setting a hunt mode still clears the worked-session set', () => {
  // Guard the edit above: the clear() lived on the same line that grew a block.
  const at = MAIN.indexOf('function setJtcatHuntMode(');
  const body = MAIN.slice(at, at + 2000);
  assert.ok(/jtcatAutoCqWorkedSession\.clear\(\)/.test(body), 'worked-session clear was lost');
});

// K3SBP 2026-09-16: ULTRACAT is the operator taking full responsibility, so
// Hunt runs as long as they leave it on; without ULTRACAT it gets the same
// 30-minute no-activity limit as Run.
test('Hunt watchdog applies only when ULTRACAT is locked', () => {
  const at = MAIN.indexOf('function jtcatFullAutoCqWatchdog()');
  assert.ok(at !== -1, 'jtcatFullAutoCqWatchdog not found');
  const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
  assert.ok(/jtcatAutoCqMode !== 'off' && !settings\.ultracat/.test(body),
    'the Hunt stop must be gated on ULTRACAT being locked');
  assert.ok(/setJtcatHuntMode\('off'/.test(body),
    'the Hunt stop must go through setJtcatHuntMode so a QSO in progress still finishes');
});

test('a given-up QSO is written to the session log', () => {
  const at = MAIN.indexOf('function jtcatHandleRetryStall(');
  const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
  assert.ok(/outcome\.action === 'abort'[\s\S]*sendCatLog\('\[JTCAT\] ' \+ msg\)/.test(body),
    'the abort notice went back to console-only — bug reports lose why a QSO ended');
});


// N2FSM 2026-09-23: Hunt All CQs ran, he called 15 CQs by hand, and Hunt
// stopped itself for "nothing from the operator" — the attended clock counted
// only Hunt/Run selection and QSO progress, never the operator's own CQ
// button or reply. Every operator-initiated TX pets the clock; automatic
// paths never do.
test('the CQ button and a manual reply pet the attended clock, on the desktop and the phone', () => {
  const at = MAIN.indexOf('function jtcatNoteOperatorAtRadio()');
  assert.ok(at !== -1, 'jtcatNoteOperatorAtRadio not found');
  assert.ok(/jtcatFullAutoCqLastActivity = Date\.now\(\)/.test(MAIN.slice(at, at + 200)), 'helper must stamp the clock');
  for (const head of [
    "ipcMain.on('jtcat-popout-call-cq', async (_e, modifier) => {",
    "ipcMain.on('jtcat-popout-reply', async (_e, data) => {",
    "remoteServer.on('jtcat-call-cq', async ({ modifier } = {}) => {",
    "remoteServer.on('jtcat-reply', async (data) => {",
  ]) {
    const h = MAIN.indexOf(head);
    assert.ok(h !== -1, head + ' not found');
    assert.ok(MAIN.slice(h, h + 700).includes('jtcatNoteOperatorAtRadio();'), head + ' does not pet the attended clock');
  }
});

test('the Hunt→Run fallback still does NOT pet the attended clock', () => {
  // startFullAutoCq({auto:true}) restamping would let the loop transmit
  // forever unattended — the Part 97 line. The stamp stays gated on !auto.
  const at = MAIN.indexOf('function startFullAutoCq(');
  const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
  assert.ok(/if \(!auto\) jtcatFullAutoCqLastActivity = Date\.now\(\);/.test(body), 'the !auto gate on the stamp was lost');
  assert.ok(!/jtcatNoteOperatorAtRadio\(\)/.test(body), 'startFullAutoCq must not call the operator-action helper');
});

// The same report: a carousel that never turned and a log that could not say
// why. Every refusal in the tick names itself once, and the clock announces
// itself when it starts counting.
test('the mode-hop tick explains every refusal in the log, once per change of reason', () => {
  const at = MAIN.indexOf('function jtcatModeHopTick(');
  const body = MAIN.slice(at, MAIN.indexOf('\nfunction ', at + 10));
  for (const needle of [
    "jtcatModeHopNote('Hunt or Auto CQ is not running",
    "jtcatModeHopNote(busy",
    "'spot target ' + jtcatSpotTarget.call + ' is armed",
    "idle clock started",
    "decision.reason === 'need-two-modes'",
  ]) assert.ok(body.includes(needle), 'missing: ' + needle);
  const note = MAIN.indexOf('function jtcatModeHopNote(');
  assert.ok(/if \(reason === _jtcatModeHopNote\) return;/.test(MAIN.slice(note, note + 300)), 'the note must dedupe, or FT2 floods the log every 3.8 s');
});

test('choosing a Hunt mode restates whether the carousel can turn', () => {
  const at = MAIN.indexOf('function setJtcatHuntMode(');
  const body = MAIN.slice(at, at + 2500);
  assert.ok(/if \(m !== 'off' && jtcatModeHopEnabled\(\)\) \{[^\n]*sendCatLog\(jtcatModeHopStatusLine\(\)\)/.test(body),
    'the toggle line is usually outside the bug report window — Hunt start must restate it');
});

test('the rotation chips no longer share a class with the Field Day chip', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'), 'utf8');
  // The later `.jp-mode-chip {` rule painted the rotation chips' OFF state
  // Field-Day orange. Only the shared base + `.on` rule may target the class.
  const bare = html.match(/^\s*\.jp-mode-chip\s*\{/gm) || [];
  assert.strictEqual(bare.length, 0, 'a bare .jp-mode-chip rule is back — the FD chip must be styled by #jp-fd-chip');
  assert.ok(/#jp-fd-chip \{/.test(html), 'FD chip rule must be id-scoped');
  assert.ok(html.includes('Green = in the rotation'), 'the chips row must say what green means');
});

console.log(`\nJTCAT hunt-off: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
