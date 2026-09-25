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


// ---------------------------------------------------------------------------
// JTCAT TX output — the same rule on the transmit side (NA7C 2026-09-09).
//
// The renderer TX route used to log a WARNING when the configured output
// device failed setSinkId and then play the FT8 envelope to the system default
// anyway — with PTT already asserted by main. A keyed radio, 0 W, no SWR, FT8
// tones out of the PC speakers, and the only evidence a line in a log nobody
// had opened. Three weeks, IC-7300, while WSJT-X worked first try.
const { describeJtcatTxAudioFault } = require('../lib/jtcat-tx-audio-fault');
const APP = fs.readFileSync(P('renderer', 'app.js'), 'utf8');
const PRELOAD = fs.readFileSync(P('preload.js'), 'utf8');

function txRouteBlock() {
  const start = APP.indexOf('async function playJtcatTxAudio(');
  assert.notStrictEqual(start, -1, 'playJtcatTxAudio not found');
  const end = APP.indexOf('window.api.onJtcatTxAudio(', start);
  assert.notStrictEqual(end, -1, 'end of playJtcatTxAudio not found');
  return APP.slice(start, end);
}

test('JTCAT TX: a CONFIGURED output that fails setSinkId refuses BEFORE any audio is built', () => {
  const block = txRouteBlock();
  const sink = block.indexOf('setSinkId(outputDeviceId)');
  assert.notStrictEqual(sink, -1, 'no setSinkId on the configured id');
  const refusal = block.indexOf('jtcatTxAudioFault(', sink);
  assert.notStrictEqual(refusal, -1, 'the setSinkId failure no longer reports a fault');
  const buffer = block.indexOf('createBufferSource()', sink);
  assert.ok(refusal < buffer, 'the fault is reported AFTER the buffer source exists — audio may already be playing');
  const tail = block.slice(block.lastIndexOf('if (outputDeviceId && !sinkApplied', refusal), buffer);
  assert.ok(tail.includes('jtcatTxComplete()'), 'the refusal does not drop PTT (jtcatTxComplete)');
  assert.ok(tail.includes('return;'), 'the refusal does not abandon playback');
  assert.ok(tail.includes('jtcatTxPlaying = false'), 'the refusal leaves jtcatTxPlaying stuck true');
});

test('JTCAT TX: raw ALSA ids and the UNCONFIGURED case keep their fallback', () => {
  // KF1G's alsa:plughw id can never be a Chromium sink and his default WAS the
  // rig; an unconfigured station may run the CODEC as the Windows default.
  const block = txRouteBlock();
  const refusalIf = block.slice(block.indexOf('if (outputDeviceId && !sinkApplied'), block.indexOf('jtcatTxAudioFault('));
  assert.ok(refusalIf.includes("indexOf('alsa:') !== 0"), 'raw ALSA ids are refused instead of falling back');
  assert.ok(refusalIf.includes('outputDeviceId &&'), 'an unconfigured output is refused');
  const unconfigured = block.indexOf('if (!outputDeviceId) {');
  assert.notStrictEqual(unconfigured, -1, 'the unconfigured branch is gone');
  assert.ok(block.slice(unconfigured, unconfigured + 400).includes('WARNING: no output device configured'),
    'the unconfigured case no longer warns');
});

test('JTCAT TX: the refusal reaches the CAT log, the popout, the main window AND remote clients', () => {
  const at = MAIN.indexOf("ipcMain.on('jtcat-tx-audio-fault'");
  assert.notStrictEqual(at, -1, 'main has no handler for the fault');
  const handler = MAIN.slice(at, at + 1200);
  assert.ok(handler.includes('sendCatLog('), 'fault bypasses the session log');
  assert.ok(handler.includes("'jtcat-qso-state', { phase: 'error'"), 'popout never sees the reason');
  assert.ok(handler.includes("'app-notice'"), 'main window never sees the reason');
  assert.ok(handler.includes("broadcastJtcatQsoState({ phase: 'error'"), 'web/mobile clients never see the reason');
  assert.ok(PRELOAD.includes("jtcatTxAudioFault: (fault) => ipcRenderer.send('jtcat-tx-audio-fault'"),
    'preload does not expose the fault channel');
});

test('JTCAT TX: the message names the cause, the consequence and the fix', () => {
  const stale = describeJtcatTxAudioFault({ name: 'NotFoundError', reason: 'Failed to execute setSinkId [NotFoundError]' });
  assert.ok(stale.startsWith('TX refused'), 'does not lead with what happened');
  assert.ok(stale.includes('not present') && stale.includes('re-enumerated'), 'stale-id cause not explained');
  assert.ok(stale.includes('will not key the radio with no audio'), 'consequence not stated');
  assert.ok(stale.includes('Settings > My Rigs > Audio'), 'does not say where to fix it');
  const other = describeJtcatTxAudioFault({ name: 'NotAllowedError', reason: 'busy' });
  assert.ok(other.includes('could not be opened (busy)'), 'non-stale failure loses its reason');
  assert.ok(other.includes('Settings > My Rigs > Audio'), 'non-stale failure does not say where to fix it');
  assert.ok(describeJtcatTxAudioFault().includes('could not be opened (unknown error)'), 'no-payload call throws or is blank');
});

// Tune keys the radio for 90 s through the same output: it used to swallow
// the setSinkId failure (`catch {}`) and play the tone to the PC speakers.
test('JTCAT Tune: a CONFIGURED output that fails setSinkId refuses and unkeys, never plays to the default', () => {
  const start = APP.indexOf('async function startJtcatTuneAudio(');
  assert.notStrictEqual(start, -1, 'startJtcatTuneAudio not found');
  const body = APP.slice(start, APP.indexOf('function stopJtcatTuneAudio(', start));
  assert.ok(!/setSinkId\(outputDeviceId\);\s*\}\s*catch\s*\{\s*\}/.test(body), 'setSinkId failure swallowed again');
  const refuse = body.indexOf('jtcatTuneAudioFailed');
  assert.ok(refuse !== -1 && refuse < body.indexOf('createOscillator'), 'must refuse before any tone is built');
  assert.ok(/context: 'tune'/.test(body) && /jtcatTxAudioFault\(/.test(body), 'reason must reach the same fault channel as FT8');
  assert.ok(/indexOf\('alsa:'\) !== 0/.test(body), 'raw ALSA keeps its fallback (KF1G)');
  const catchAll = body.slice(body.lastIndexOf('catch (err)'));
  assert.ok(/jtcatTuneAudioFailed/.test(catchAll), 'any tune audio failure unkeys the radio');
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const h = MAIN.slice(MAIN.indexOf("ipcMain.on('jtcat-tune-audio-failed'"), MAIN.indexOf("ipcMain.on('jtcat-tune-toggle'"));
  assert.ok(/stopJtcatTune\(\)/.test(h), 'main must unkey on the renderer\'s report');
  assert.ok(describeJtcatTxAudioFault({ context: 'tune', name: 'NotFoundError' }).startsWith('Tune refused:'));
  assert.ok(describeJtcatTxAudioFault({ name: 'NotFoundError' }).startsWith('TX refused:'));
});

console.log(`\nAudio capture device: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
