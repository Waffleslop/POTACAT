#!/usr/bin/env node
'use strict';
// #757 (Linux 6.1, IC-7300 PCM2901 codec, PulseAudio/PipeWire): two captures
// of the same radio input, ECHOCAT audio (opened with no channel count, so
// 2 ch) and the Winlink modem bridge / JTCAT (1 ch). The one opened second
// received samples at a normal level that could not be decoded.
//
// Every capture of the radio's input asks for the same layout: 1 channel,
// echo cancellation, noise suppression and auto gain off. Two record streams
// of one source then share one layout, whichever opens first. The phone hears
// no difference: the WebRTC sender is mono Opus (no stereo in the SDP).
//
// Unverified on Linux: no PipeWire/PulseAudio rig here to reproduce on.
//
// Run: node test/rig-capture-layout-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const root = path.join(__dirname, '..');
const src = (f) => readSrc(path.join(root, f));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

// The text of the constraint object that starts at `anchor` (balanced braces).
function objectAt(text, anchor, what) {
  const i = text.indexOf(anchor);
  assert.ok(i >= 0, what + ': anchor not found: ' + anchor);
  const open = text.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}' && --depth === 0) return text.slice(open, k + 1);
  }
  throw new Error(what + ': unbalanced object at ' + anchor);
}

function sameLayout(obj, what) {
  assert.ok(/channelCount:\s*1\b/.test(obj), what + ' does not ask for 1 channel: ' + obj.replace(/\s+/g, ' '));
  for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
    assert.ok(new RegExp(k + ':\\s*false').test(obj), what + ' leaves ' + k + ' on');
  }
}

const audioHtml = src('renderer/remote-audio.html');
const winlink = src('renderer/winlink-popout.js');

test('ECHOCAT audio (remote-audio.html): the bridge capture asks for 1 channel', () => {
  sameLayout(objectAt(audioHtml, 'const baseAudio = {', 'ECHOCAT bridge'), 'ECHOCAT bridge');
});
test('ECHOCAT audio (remote-audio.html): the rx-spectrum capture asks for 1 channel', () => {
  const i = audioHtml.indexOf('window.api.onRxSpectrumWant(');
  sameLayout(objectAt(audioHtml.slice(i), 'getUserMedia({ audio:', 'rx-spectrum').slice(1), 'rx-spectrum capture');
});
test('Winlink window waterfall: its capture of the radio asks for 1 channel', () => {
  const i = winlink.indexOf('window.api.audioRig().then(function (rig) {');
  assert.ok(i >= 0, 'waterfall capture not found');
  const line = winlink.slice(i, winlink.indexOf('getUserMedia(c)', i));
  const objs = (line.replace(/\{ exact: rig\.inputId \}/g, 'ID').match(/\{[^{}]*echoCancellation[^{}]*\}/g)) || [];
  assert.strictEqual(objs.length, 2, 'expected the device and default constraint objects');
  objs.forEach((o, n) => sameLayout(o, 'Winlink waterfall constraint ' + (n + 1)));
});
test('the captures it shares the device with keep asking for 1 channel', () => {
  sameLayout(objectAt(src('renderer/modem-audio-bridge.js'), 'audio: {', 'modem bridge'), 'modem bridge');
  sameLayout(objectAt(src('renderer/app.js'), 'var audioConstraints = {', 'main-window JTCAT'), 'main-window JTCAT');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
