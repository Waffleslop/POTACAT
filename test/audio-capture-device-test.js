#!/usr/bin/env node
'use strict';
// ECHOCAT audio bridge: the capture device is the operator's choice, never a
// substitute (N2FSM 2026-08-28, IC-7300).
//
// The bridge used to fall back to the DEFAULT input when the configured device
// was missing. On a shack PC the default input is the built-in microphone, and
// Windows device IDs rotate across driver/USB changes and app updates — so a
// rig that had worked for months silently came back as an open room mic. Shack
// audio went to the phone, the phone's speaker fed the room, the room fed the
// mic: a feedback loop that persisted with the radio volume at zero, because
// the radio was never in the loop. It is also a privacy failure — a hot mic
// streamed to a phone and potentially over a TURN relay — and nothing said so,
// because the one diagnostic that existed went to console.error and never
// reached session.log or a bug report.
// Run: node test/audio-capture-device-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const P = (...f) => path.join(__dirname, '..', ...f);
const BRIDGE = fs.readFileSync(P('renderer', 'remote-audio.html'), 'utf8');
const MAIN = fs.readFileSync(P('main.js'), 'utf8');

// The capture block: from the configured-device branch to the end of the
// else branch. Everything asserted below lives in that window.
function captureBlock() {
  const start = BRIDGE.indexOf('if (config.inputDeviceId) {');
  assert.notStrictEqual(start, -1, 'capture branch not found');
  const end = BRIDGE.indexOf('getAudioTracks()[0]', start);
  assert.notStrictEqual(end, -1, 'capture block end marker not found');
  return BRIDGE.slice(start, end);
}

test('a CONFIGURED device that is missing captures NOTHING', () => {
  const block = captureBlock();
  const c = block.indexOf('catch');
  assert.notStrictEqual(c, -1, 'no catch on the exact-device request');
  const handler = block.slice(c, block.indexOf('} else {', c));
  // The whole bug: the catch used to call getUserMedia again without a
  // deviceId, which is the system microphone.
  assert.ok(!/getUserMedia/.test(handler),
    'the failure path still opens another device — that is the microphone bug');
  assert.ok(/return;/.test(handler), 'the failure path must abandon capture');
});

test('the refusal explains itself and says the mic was NOT used', () => {
  const block = captureBlock();
  assert.ok(/microphone was NOT used/i.test(block),
    'the error does not reassure the operator about the microphone');
  assert.ok(/Settings > My Rigs > Audio/.test(block),
    'the error does not say where to fix it');
});

test('an exact deviceId is demanded, never a soft preference', () => {
  // `deviceId: id` (no `exact`) silently falls back to the default device —
  // the same failure by another route.
  const block = captureBlock();
  assert.ok(/deviceId:\s*\{\s*exact:/.test(block), 'device request is not exact');
});

test('the UNCONFIGURED case still works, but warns', () => {
  // Some stations legitimately run the rig's codec AS the Windows default and
  // have never configured anything; breaking them would trade one bug for
  // another. It must not be silent, though.
  const block = captureBlock();
  const elseBranch = block.slice(block.indexOf('} else {'));
  assert.ok(/getUserMedia/.test(elseBranch), 'unconfigured stations lost their audio');
  assert.ok(/warning:/.test(elseBranch), 'the default-device case is still silent');
});

test('the device actually captured is always reported', () => {
  assert.ok(/captureLabel/.test(BRIDGE), 'bridge never reports what it opened');
  assert.ok(/getAudioTracks\(\)\[0\]/.test(BRIDGE), 'label not taken from the live track');
});

test('label, warning and error all reach the CAT log (not just console)', () => {
  // console.error is invisible in a bug report — that is why the original
  // report contained no evidence at all.
  const at = MAIN.indexOf("ipcMain.on('remote-audio-status'");
  assert.notStrictEqual(at, -1, 'status handler moved');
  const handler = MAIN.slice(at, at + 4000);
  for (const [field, why] of [
    ['status.captureLabel', 'captured device never logged'],
    ['status.warning', 'warning never logged'],
    ['status.error', 'error never logged'],
  ]) {
    const i = handler.indexOf(field);
    assert.notStrictEqual(i, -1, field + ' not handled');
  }
  const errAt = handler.indexOf('if (status.error)');
  const errBlock = handler.slice(errAt, errAt + 400);
  assert.ok(/sendCatLog/.test(errBlock), 'audio errors still bypass the session log');
});

console.log(`\nAudio capture device: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
