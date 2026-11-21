#!/usr/bin/env node
'use strict';
// APRS "Listen on my radio" pauses when the radio moves off the APRS frequency
// (on air 2026-11-20, FLEX-8600M on Flex Direct: listening started on 10.1476
// MHz DIGU, then spot clicks and the phone took the radio to 28.074 FT8 and
// 18/14/7 MHz SSB; the window kept saying "Listening on my radio" on 30 m for
// an hour). Plus the once-a-minute audio line, and the main.js wiring.
// Run: node test/aprs-listen-moved-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/aprs-listen');
const A = require('../lib/aprs-listen-audio');
const W = require('../lib/aprs-window-state');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function clock(t0 = 1000000) { let t = t0; const f = () => t; f.add = (ms) => { t += ms; }; return f; }
const HF = 10147600;

console.log('APRS listening: the radio moved');

test('mode families: every codec\'s upper-sideband data mode is USB; FM data is FM; unknown is unknown', () => {
  for (const m of ['USB', 'DIGU', 'PKTUSB', 'DATA-U', 'USB-D', 'USB-D1', 'usb']) assert.strictEqual(L.modeFamily(m), 'usb', m);
  for (const m of ['LSB', 'DIGL', 'PKTLSB', 'DATA-L', 'LSB-D']) assert.strictEqual(L.modeFamily(m), 'lsb', m);
  for (const m of ['FM', 'FM-D', 'PKT', 'DATA-FM', 'NFM', 'PKTFM']) assert.strictEqual(L.modeFamily(m), 'fm', m);
  assert.strictEqual(L.modeFamily('AM'), 'am');
  assert.strictEqual(L.modeFamily('CW-R'), 'cw');
  assert.strictEqual(L.modeFamily('VFOA'), '');
  assert.strictEqual(L.modeFamily(''), '');
  assert.strictEqual(L.listenFamily('30m'), 'usb');
  assert.strictEqual(L.listenFamily('2m'), 'fm');
});

test('the 2026-11-20 log: 30 m DIGU, then a spot click to 28.074 FT8 pauses listening', () => {
  const now = clock();
  const w = L.createMoveWatch({ band: '30m', listenHz: HF, now });
  assert.strictEqual(w.check({ hz: HF, mode: 'DIGU' }), null);
  now.add(60000);
  assert.strictEqual(w.check({ hz: HF, mode: 'DIGU' }), null, 'still on 30 m');
  const m = w.check({ hz: 28074000, mode: 'DIGU' });
  assert.deepStrictEqual(m, { why: 'frequency', hz: 28074000, mode: 'DIGU' });
});

test('ECHOCAT tuning to 14.317 USB, 18.127 USB, 7.213 LSB: each is a move', () => {
  for (const [hz, mode] of [[14317000, 'USB'], [18127000, 'USB'], [7213000, 'LSB']]) {
    const now = clock();
    const w = L.createMoveWatch({ band: '30m', listenHz: HF, now });
    w.check({ hz: HF, mode: 'DIGU' });
    now.add(5000);
    const m = w.check({ hz, mode });
    assert.ok(m && m.why === 'frequency', hz + ' ' + mode);
  }
});

test('tolerance: the radio\'s own rounding is not a move (within ' + L.MOVED_TOL_HZ + ' Hz)', () => {
  assert.strictEqual(L.MOVED_TOL_HZ, 100);
  const now = clock();
  const w = L.createMoveWatch({ band: '30m', listenHz: HF, now });
  now.add(5000);
  assert.strictEqual(w.check({ hz: HF + 10, mode: 'DIGU' }), null, '10 Hz steps');
  assert.strictEqual(w.check({ hz: HF - 100, mode: 'DIGU' }), null, 'at the tolerance');
  assert.ok(w.check({ hz: HF + 500, mode: 'DIGU' }), 'a 500 Hz nudge of the knob is a move');
});

test('a radio that settles a little off (its first readback on the frequency) stays put there', () => {
  const now = clock();
  const w = L.createMoveWatch({ band: '2m', listenHz: 144390000, now });
  w.check({ hz: 144390500, mode: 'FM' }); // accepted within 1 kHz by the start (tuneAccepted)
  now.add(5000);
  assert.strictEqual(w.check({ hz: 144390500, mode: 'FM' }), null);
  assert.strictEqual(w.check({ hz: 144390000, mode: 'FM' }), null);
  assert.ok(w.check({ hz: 146520000, mode: 'FM' }), 'to the simplex calling frequency: a move');
});

test('grace: readbacks settle for ' + L.MOVED_GRACE_MS + ' ms after listening starts; a move after it still counts', () => {
  const now = clock();
  const w = L.createMoveWatch({ band: '30m', listenHz: HF, now });
  assert.strictEqual(w.check({ hz: 14074000, mode: 'USB' }), null, 'inside the grace');
  now.add(L.MOVED_GRACE_MS);
  assert.ok(w.check({ hz: 14074000, mode: 'USB' }), 'after it');
});

test('our own APRS radio beacon in flight never counts', () => {
  const now = clock();
  const w = L.createMoveWatch({ band: '30m', listenHz: HF, now });
  now.add(10000);
  assert.strictEqual(w.check({ hz: 14317000, mode: 'USB', rfInFlight: true }), null);
});

test('no readback yet (0 Hz) is not a move', () => {
  const now = clock();
  const w = L.createMoveWatch({ band: '30m', listenHz: HF, now });
  now.add(10000);
  assert.strictEqual(w.check({ hz: 0, mode: '' }), null);
});

test('mode: DIGU -> USB is still upper sideband; DIGU -> LSB, CW or FM on the same dial is a move', () => {
  const now = clock();
  const w = L.createMoveWatch({ band: '30m', listenHz: HF, now });
  w.check({ hz: HF, mode: 'DIGU' });
  now.add(5000);
  assert.strictEqual(w.check({ hz: HF, mode: 'USB' }), null);
  assert.strictEqual(w.check({ hz: HF, mode: 'PKTUSB' }), null);
  assert.strictEqual(w.check({ hz: HF, mode: 'MYSTERY' }), null, 'an unknown name never pauses');
  assert.deepStrictEqual(w.check({ hz: HF, mode: 'LSB' }), { why: 'mode', hz: HF, mode: 'LSB' });
  assert.ok(w.check({ hz: HF, mode: 'CW' }));
});

test('mode: a lagging readback of the old mode before the radio ever read back the APRS mode is not a move', () => {
  const now = clock();
  const w = L.createMoveWatch({ band: '2m', listenHz: 144390000, now });
  now.add(5000);
  assert.strictEqual(w.check({ hz: 144390000, mode: 'USB' }), null, 'never seen FM yet');
  assert.strictEqual(w.check({ hz: 144390000, mode: 'FM-D' }), null);
  assert.ok(w.check({ hz: 144390000, mode: 'USB' }), 'after FM was seen, USB is a move');
});

test('wording: the card title and line, from where the radio is now', () => {
  assert.strictEqual(L.MOVED_TITLE, 'Paused: your radio moved');
  assert.strictEqual(L.movedLine({ hz: 14317000, mode: 'USB', band: '30m' }), 'Your radio is on 14.317 MHz USB. Turn listening on to go back to 30 m.');
  assert.strictEqual(L.movedLine({ hz: 146520000, mode: 'FM', band: '2m' }), 'Your radio is on 146.520 MHz FM. Turn listening on to go back to 2 m.');
  assert.strictEqual(L.movedLine({ hz: 0, band: '30m' }), 'Your radio moved off the APRS frequency. Turn listening on to go back to 30 m.');
  assert.strictEqual(L.movedSentence({ hz: 14317000, mode: 'USB', band: '30m' }), 'Paused: your radio moved. Your radio is on 14.317 MHz USB. Turn listening on to go back to 30 m.');
  const log = L.movedLogLine({ hz: 28074000, mode: 'DIGU', listenMhz: '10.1476', why: 'frequency' });
  assert.ok(log.startsWith('paused: the radio moved to 28.0740 MHz DIGU, off 10.1476 MHz.'), log);
  assert.ok(/stays where it was put/.test(log) && /no return/.test(log), log);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(log + L.movedSentence({})), 'no emoji');
});

test('window: the radio card says it in plain words, switch Off (turning it on is the normal start)', () => {
  const listen = { on: false, state: 'refused', band: '30m', bands: ['2m', '30m'], modeLabel: 'USB', mhz: '', heard: 4, lastAt: 0, note: '',
    sentence: L.movedSentence({ hz: 14317000, mode: 'USB', band: '30m' }), dialMhz: '14.317', dialMode: 'USB',
    moved: { title: L.MOVED_TITLE, line: L.movedLine({ hz: 14317000, mode: 'USB', band: '30m' }) } };
  const c = W.radioCard({ listen });
  assert.strictEqual(c.title, 'Paused: your radio moved');
  assert.deepStrictEqual(c.lines, ['Your radio is on 14.317 MHz USB. Turn listening on to go back to 30 m.']);
  assert.strictEqual(c.switchOn, false);
  assert.strictEqual(c.switchDisabled, false);
  assert.strictEqual(c.dot, 'wait');
  assert.strictEqual(c.kind, 'off');
  assert.ok(c.bandSelect && c.bandSelect.value === '30m');
});

console.log('APRS listening: the audio line');

test('peak in dBFS', () => {
  assert.strictEqual(Math.round(A.peakDbfs(1)), 0);
  assert.strictEqual(Math.round(A.peakDbfs(0.1)), -20);
  assert.strictEqual(A.peakDbfs(0), -Infinity);
});

test('the line: peak and frames; no samples; silence below -90 dBFS', () => {
  assert.strictEqual(A.audioLevelLine({ mhz: '10.1476', samples: 720000, peak: 0.0708, frames: 4 }), 'listening on 10.1476 MHz: audio peak -23 dBFS, 4 frames decoded this minute');
  assert.strictEqual(A.audioLevelLine({ mhz: '10.1476', samples: 720000, peak: 0.5, frames: 1 }), 'listening on 10.1476 MHz: audio peak -6 dBFS, 1 frame decoded this minute');
  assert.strictEqual(A.audioLevelLine({ mhz: '10.1476', samples: 0, peak: 0, frames: 0 }), 'listening on 10.1476 MHz: no audio reaching Dire Wolf (no samples this minute), 0 frames decoded this minute');
  assert.strictEqual(A.audioLevelLine({ mhz: '10.1476', samples: 720000, peak: 0.00001, frames: 0 }), 'listening on 10.1476 MHz: no audio reaching Dire Wolf (peak below -90 dBFS), 0 frames decoded this minute');
  assert.strictEqual(A.audioLevelLine({ mhz: '144.390', samples: 10, peak: 1.4, frames: 0 }), 'listening on 144.390 MHz: audio peak 0 dBFS, 0 frames decoded this minute', 'clipped audio reads 0, never above');
});

test('the minute: one line per whole minute from the lane\'s stats, then it starts again', () => {
  const now = clock();
  const m = A.createAudioMinute({ now });
  assert.strictEqual(m.due({ mhz: '10.1476' }), '', 'not started');
  m.start();
  m.noteStats({ socketRxSamples: 1000, rxPeak: 0.01 });
  m.noteStats({ socketRxSamples: 13000, rxPeak: 0.0708 });
  m.noteStats({ socketRxSamples: 25000, rxPeak: 0.02 });
  m.noteFrame(); m.noteFrame();
  now.add(30000);
  assert.strictEqual(m.due({ mhz: '10.1476' }), '', 'half a minute: nothing');
  now.add(30000);
  assert.strictEqual(m.due({ mhz: '10.1476' }), 'listening on 10.1476 MHz: audio peak -23 dBFS, 2 frames decoded this minute');
  assert.strictEqual(m.due({ mhz: '10.1476' }), '', 'one line a minute');
  // The next minute: the lane's meters were reset (a Winlink session), then nothing at all.
  m.noteStats({ socketRxSamples: 25000, rxPeak: 0 });
  now.add(60000);
  assert.strictEqual(m.due({ mhz: '10.1476' }), 'listening on 10.1476 MHz: no audio reaching Dire Wolf (no samples this minute), 0 frames decoded this minute');
  m.noteStats({ socketRxSamples: 500, rxPeak: 0.3 }); // a reset count starts again from its own value
  now.add(60000);
  assert.ok(/audio peak -10 dBFS/.test(m.due({ mhz: '10.1476' })));
  m.stop();
  now.add(60000);
  assert.strictEqual(m.due({ mhz: '10.1476' }), '', 'stopped: no line');
});

console.log('APRS listening: main.js wiring');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function fnBody(name) {
  const i = main.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = main.indexOf('\n}\n', i);
  return main.slice(i, j);
}

test('every frequency readback checks for a move', () => {
  assert.ok(/aprsRadioReturnOnDial\(hz\);[^\n]*\n\s*aprsListenOnDial\(\);/.test(main));
  assert.ok(/aprsListenCheckMoved\(\)/.test(fnBody('aprsListenOnDial')));
  assert.ok(/aprsListenCheckMoved\(\)/.test(fnBody('aprsListenTick')), 'the tick catches a mode-only change');
});

test('the watch exists only once listening has started, never during our own tune', () => {
  const start = fnBody('aprsListenStart');
  const iWatch = start.indexOf('AprsListen.createMoveWatch(');
  assert.ok(iWatch > 0);
  assert.ok(iWatch > start.lastIndexOf("aprsListen.state = 'listening'"), 'made after the state is listening');
  assert.ok(iWatch > start.indexOf('aprsSpawnDirewolf(seq)'), 'after the tune, the data mode and Dire Wolf');
  assert.ok(/aprsListen\.watch = null/.test(start), 'a start clears the old watch');
  assert.ok(/aprsListen\.watch = null/.test(fnBody('aprsListenYieldToWinlink')), 'Winlink\'s tune is not a move');
  assert.ok(/aprsListen\.state !== 'listening'/.test(fnBody('aprsListenCheckMoved')));
  assert.ok(/rfInFlight: aprsRfInFlight\(\)/.test(fnBody('aprsListenCheckMoved')), 'the beacon in flight is passed in');
});

test('a move pauses: switch off, modem stopped, and the return is dropped, never run (the radio stays put)', () => {
  const b = fnBody('aprsListenMovedOff');
  assert.ok(/aprsListen\.on = false/.test(b));
  assert.ok(/aprsStopModem\(\)/.test(b));
  assert.ok(/aprsReleaseLane\(\)/.test(b));
  assert.ok(/aprsReturn\.drop\(\)/.test(b));
  assert.ok(!/aprsReturn\.end\(|tuneRadio\(|setFreq|aprsRf[A-Z]\w*\(/.test(b), 'no tune, no return, nothing about transmit');
  assert.ok(/aprsListen\.moved = /.test(b));
  assert.ok(/aprsListenPush\(\)/.test(b));
});

test('the window and ECHOCAT get the paused words with no new wire field (sentence, state refused)', () => {
  const p = fnBody('aprsListenPayload');
  assert.ok(/moved: aprsListenMovedView\(band\)/.test(p));
  assert.ok(/AprsListen\.movedSentence\(/.test(p));
  const echo = fs.readFileSync(path.join(__dirname, '..', 'lib', 'aprs-echocat.js'), 'utf8');
  assert.ok(!/moved/.test(echo), 'aprs-state carries no moved field');
});

test('the audio line: the lane\'s stats feed it, frames are counted, the tick logs it', () => {
  assert.ok(/srv\.on\('stats', \(d\) => \{ if \(_aprsAudioMinute\.running\(\)\) _aprsAudioMinute\.noteStats\(d\); \}\)/.test(main));
  assert.ok(/_aprsAudioMinute\.noteFrame\(\)/.test(fnBody('aprsOnMonitorFrame')));
  assert.ok(/_aprsAudioMinute\.due\(/.test(fnBody('aprsListenTick')));
  assert.ok(/_aprsAudioMinute\.start\(\)/.test(fnBody('aprsListenStart')));
  assert.ok(/_aprsAudioMinute\.stop\(\)/.test(fnBody('aprsListenStop')));
  const lane = fs.readFileSync(path.join(__dirname, '..', 'lib', 'modem-audio-lane.js'), 'utf8');
  assert.ok(/rxPeak: srv\.takeRxPeak\(\)/.test(lane), 'the lane reports the peak of the audio written to Dire Wolf');
});

// #843: a data mode on LSB at 10.1476 MHz hears none of the tones, and the
// move watch never pauses for it (the right family was never read back).
test('#843: a 30 m radio on lower sideband gets one sentence; upper sideband and 2 m get none', () => {
  assert.strictEqual(L.sidebandSentence('30m', 'LSB'), 'Your radio is on lower sideband (LSB). APRS on 30 m is upper sideband: set the radio\'s data mode to USB, or nothing will decode.');
  assert.ok(L.sidebandSentence('30m', 'DATA-L'));
  assert.ok(L.sidebandSentence('30m', 'PKTLSB'));
  assert.ok(L.sidebandSentence('30m', 'DIGL'));
  assert.strictEqual(L.sidebandSentence('30m', 'DIGU'), '');
  assert.strictEqual(L.sidebandSentence('30m', 'USB'), '');
  assert.strictEqual(L.sidebandSentence('30m', ''), '');      // no readback yet: nothing said
  assert.strictEqual(L.sidebandSentence('30m', 'XYZ'), '');   // a name POTACAT does not know: nothing said
  assert.strictEqual(L.sidebandSentence('2m', 'LSB'), '');
});

test('#843: main shows the sentence in the note line while listening, after the settle time', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function aprsListenSidebandNote()'), main.indexOf('function aprsListenMovedOff('));
  assert.ok(/AprsListen\.sidebandSentence\(aprsListen\.band, _currentMode\)/.test(fn));
  assert.ok(/MOVED_GRACE_MS/.test(fn), 'waits for readbacks to settle');
  assert.ok(/aprsListen\.note = \[aprsListen\.noteBase/.test(fn), 'keeps the setup and filter lines');
  assert.ok(/if \(!m\) \{ aprsListenSidebandNote\(\); return false; \}/.test(main), 'checked on every readback that is not a move');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
