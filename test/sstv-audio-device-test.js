#!/usr/bin/env node
'use strict';
// SSTV listens to, and transmits through, the RADIO's audio device (My Rigs >
// Audio), like FT8 and ECHOCAT. It used to default to the computer's default
// device, so on a USB-codec or SignaLink station it decoded the laptop mic
// while everything else worked, and a saved device that had gone away was
// silently replaced (Casey 2026-09-28: "Nobody is getting good rx").
// Run: node test/sstv-audio-device-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveSstvAudio } = require('../lib/sstv-audio-device');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const DEVICES = [
  { deviceId: 'mic', label: 'Laptop Microphone' },
  { deviceId: 'codec', label: 'USB Audio CODEC' },
];

console.log('SSTV audio device');

test('an unset SSTV input follows the radio input', () => {
  const r = resolveSstvAudio({ sstvId: '', rigId: 'codec', devices: DEVICES, kind: 'input' });
  assert.deepStrictEqual([r.ok, r.deviceId, r.source, r.label, r.notice], [true, 'codec', 'rig', 'USB Audio CODEC', null]);
});

test('a missing radio input is refused, never replaced by the default', () => {
  const r = resolveSstvAudio({ sstvId: '', rigId: 'gone', devices: DEVICES, kind: 'input' });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /My Rigs > Audio/);
});

test('a device chosen in the SSTV window still overrides, and says when it differs', () => {
  const r = resolveSstvAudio({ sstvId: 'mic', rigId: 'codec', devices: DEVICES, kind: 'input' });
  assert.deepStrictEqual([r.ok, r.deviceId, r.source], [true, 'mic', 'sstv']);
  assert.match(r.notice, /not your radio's input \(USB Audio CODEC\)/);
  const same = resolveSstvAudio({ sstvId: 'codec', rigId: 'codec', devices: DEVICES, kind: 'input' });
  assert.strictEqual(same.notice, null, 'no notice when the override is the radio device');
});

test('a chosen SSTV device that is no longer connected is refused', () => {
  const r = resolveSstvAudio({ sstvId: 'gone', rigId: 'codec', devices: DEVICES, kind: 'input' });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /not connected/);
});

test('nothing configured anywhere: the default device, with a warning', () => {
  const r = resolveSstvAudio({ sstvId: '', rigId: '', devices: DEVICES, kind: 'input' });
  assert.deepStrictEqual([r.ok, r.deviceId, r.source], [true, '', 'default']);
  assert.match(r.notice, /No radio audio input/);
});

test('raw ALSA ids count as present (the capture path opens them itself)', () => {
  const r = resolveSstvAudio({ sstvId: '', rigId: 'alsa:hw:1,0', devices: DEVICES, kind: 'input' });
  assert.strictEqual(r.ok, true);
});

test('the output follows the same rules', () => {
  const OUT = [{ deviceId: 'spk', label: 'Speakers' }, { deviceId: 'codec-out', label: 'USB Audio CODEC' }];
  assert.strictEqual(resolveSstvAudio({ sstvId: '', rigId: 'codec-out', devices: OUT, kind: 'output' }).deviceId, 'codec-out');
  const gone = resolveSstvAudio({ sstvId: '', rigId: 'x', devices: OUT, kind: 'output' });
  assert.strictEqual(gone.ok, false);
  assert.match(gone.message, /radio output/);
});

test('the SSTV window uses the resolver for RX and TX, and never falls back silently', () => {
  const js = R('renderer/sstv-popout.js');
  const html = R('renderer/sstv-popout.html');
  assert.ok(html.indexOf('../lib/sstv-audio-device.js') > 0 && html.indexOf('../lib/sstv-audio-device.js') < html.indexOf('sstv-popout.js"'), 'module loads before the window script');
  const rx = js.slice(js.indexOf('async function startRxAudio('), js.indexOf('async function startRxAudio(') + 6000);
  assert.ok(/rigId: settings\.remoteAudioInput/.test(rx), 'RX resolves against the radio input');
  assert.ok(/if \(!pick\.ok\) \{[\s\S]{0,200}return;/.test(rx), 'a refused device does not open anything');
  assert.ok(/Listening on ' \+ heard/.test(rx), 'the status line names the device');
  assert.ok(!/<option value="">Default<\/option>/.test(js), 'no "Default" (system microphone) first option');
  assert.ok(/rigId: txSettings\.remoteAudioOutput/.test(js), 'TX resolves against the radio output');
  assert.ok(/if \(!out\.ok\) throw new Error\(out\.message\)/.test(js), 'a missing TX output refuses (and unkeys) instead of playing to the speakers');
  assert.ok(!/Could not set TX output device/.test(js), 'no warn-and-continue on a failed setSinkId');
});

console.log(`\nSSTV audio device: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
