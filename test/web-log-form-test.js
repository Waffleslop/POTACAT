#!/usr/bin/env node
'use strict';
// Web log form + CW macro {call} (LZ3AW 2026-08-29).
//
// Three defects, all "the form doesn't follow what the operator is doing":
//   1. The log sheet snapshotted the frequency at OPEN and never updated, so
//      a QSO logged after any retune was written on the wrong frequency.
//   2. No date/time at all — invisible, and unusable for a QSO written up
//      later, even though the desktop's log-qso has accepted `qsoAt` since
//      the JS8 logging work.
//   3. {call} in CW macros only ever expanded to the TUNED SPOT. Running a
//      frequency, you answer callers you were never tuned to; N1MM sends
//      what is in the entry field. The desktop had the same hole through a
//      different door: its expander reads the in-window log dialog, and a
//      spot's Log button routes to the POP-OUT (a separate BrowserWindow)
//      whenever it is open — so {call} came out empty there.
// Source-level assertions: this logic lives in renderers that cannot be
// require()'d (no Node in the renderer; remote.js is inlined at serve time).
// Run: node test/web-log-form-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const P = (...f) => path.join(__dirname, '..', ...f);
const REMOTE = fs.readFileSync(P('renderer', 'remote.js'), 'utf8');
const REMOTE_HTML = fs.readFileSync(P('renderer', 'remote.html'), 'utf8');
const APP = fs.readFileSync(P('renderer', 'app.js'), 'utf8');
const PRELOAD = fs.readFileSync(P('preload.js'), 'utf8');
const PRELOAD_POPOUT = fs.readFileSync(P('preload-log-popout.js'), 'utf8');
const POPOUT_JS = fs.readFileSync(P('renderer', 'log-popout.js'), 'utf8');
const MAIN = fs.readFileSync(P('main.js'), 'utf8');

// --- 1. The open log sheet follows the radio -------------------------------

test('the open log sheet re-reads the radio frequency on status pushes', () => {
  assert.ok(/function logSheetFollowRadio\(\)/.test(REMOTE), 'no follow function');
  // It must be DRIVEN — a helper nobody calls is the same bug.
  const inStatus = REMOTE.indexOf('currentFreqKhz = s.freq / 1000;');
  assert.notStrictEqual(inStatus, -1, 'status handler moved');
  const window = REMOTE.slice(inStatus, inStatus + 400);
  assert.ok(/logSheetFollowRadio\(\)/.test(window), 'follow not called from the status push');
});

test('a frequency the operator typed is never overwritten', () => {
  assert.ok(/logFreqDirty = true;/.test(REMOTE), 'no dirty flag on input');
  assert.ok(/if \(!logFreqDirty && currentFreqKhz\)/.test(REMOTE), 'follow ignores the dirty flag');
});

test("a spot's prefilled frequency counts as the operator's choice", () => {
  // Opening from a spot must keep the SPOT's frequency, not snap to the dial.
  assert.ok(/logFreqDirty = !!p\.freqKhz;/.test(REMOTE), 'prefill does not protect the spot frequency');
});

// --- 2. Visible, editable UTC date/time ------------------------------------

test('the form has UTC date and time inputs', () => {
  assert.ok(/id="log-date"/.test(REMOTE_HTML), 'no date input');
  assert.ok(/id="log-time"/.test(REMOTE_HTML), 'no time input');
  assert.ok(/type="date"/.test(REMOTE_HTML) && /type="time"/.test(REMOTE_HTML), 'wrong input types');
});

test('date/time track the clock until touched, then stop', () => {
  assert.ok(/logTimeDirty = true;/.test(REMOTE), 'no dirty flag');
  assert.ok(/if \(!logTimeDirty\) logStampNow\(\);/.test(REMOTE), 'clock overwrites an edited time');
});

test('an edited time is SENT as qsoAt (the exchange time, not the tap time)', () => {
  assert.ok(/function logQsoAt\(\)/.test(REMOTE), 'no qsoAt builder');
  assert.ok(/if \(qsoAt\) baseData\.qsoAt = qsoAt;/.test(REMOTE), 'qsoAt never reaches the payload');
  // And the desktop must still accept it.
  assert.ok(/const at = Number\(data\.qsoAt\);/.test(MAIN), 'desktop no longer honours qsoAt');
});

test('qsoAt is parsed as UTC, not local time', () => {
  // A Z-less Date.parse of "YYYY-MM-DDTHH:MM" is LOCAL — that would log every
  // QSO off by the operator's UTC offset, which is worse than no field.
  assert.ok(/Date\.parse\(logDate\.value \+ 'T' \+ logTime\.value \+ ':00Z'\)/.test(REMOTE),
    'date/time parsed without an explicit Z');
});

// --- 3. {call} follows the callsign being worked ---------------------------

test('web {call} prefers a typed callsign over the tuned spot', () => {
  assert.ok(/function macroCallsign\(\)/.test(REMOTE), 'no macroCallsign helper');
  assert.ok(/\.replace\(\/\\\{call\\\}\/gi, macroCallsign\(\)\)/.test(REMOTE),
    '{call} still expands straight from tunedCallsign');
});

test('web PSK $CALL falls back to the log field too', () => {
  const i = REMOTE.indexOf('function pskSubstituteMacro');
  assert.notStrictEqual(i, -1);
  assert.ok(/logCall && logCall\.value/.test(REMOTE.slice(i, i + 500)), 'PSK ignores the log field');
});

test('the Log POP-OUT reports its callsign to the main window', () => {
  // Separate BrowserWindow: the desktop expander cannot read its DOM, so the
  // value has to travel preload -> main -> renderer.
  assert.ok(/reportCallsign:/.test(PRELOAD_POPOUT), 'popout preload exposes nothing');
  assert.ok(/window\.api\.reportCallsign/.test(POPOUT_JS), 'popout never reports');
  assert.ok(/ipcMain\.on\('log-popout-callsign'/.test(MAIN), 'main does not relay');
  assert.ok(/onLogPopoutCallsign:/.test(PRELOAD), 'main preload exposes no listener');
});

test('desktop {call} prefers in-window, then pop-out, then the tuned spot', () => {
  const i = APP.indexOf('function expandDesktopCwMacros');
  assert.notStrictEqual(i, -1);
  const body = APP.slice(i, i + 900);
  assert.ok(/const call = typed \|\| _logPopoutCallsign/.test(body), 'pop-out not in the fallback chain');
  assert.ok(/lastTunedSpot \? lastTunedSpot\.callsign/.test(body), 'lost the tuned-spot fallback');
});

console.log(`\nWeb log form / {call}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
