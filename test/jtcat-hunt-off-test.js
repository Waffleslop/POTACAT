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

console.log(`\nJTCAT hunt-off: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
