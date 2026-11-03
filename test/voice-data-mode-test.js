'use strict';
// Voice in DATA mode (GitHub #24, Xiegu G90): rig.voiceAsData sends voice
// USB/LSB as DIGU/DIGL and reads the DATA report back as the voice mode.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const V = require('../lib/voice-data-mode');
const { RigController } = require('../lib/rig-controller');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('voice-data-mode: pure rules');
test('voice requests map to DATA', () => {
  assert.strictEqual(V.voiceToData('USB', 14250000), 'DIGU');
  assert.strictEqual(V.voiceToData('lsb', 7200000), 'DIGL');
  assert.strictEqual(V.voiceToData('SSB', 14250000), 'DIGU');
  assert.strictEqual(V.voiceToData('SSB', 7200000), 'DIGL');
  assert.strictEqual(V.voiceToData('SSB', 5357000), 'DIGU'); // 60 m is USB
});
test('anything else is left alone', () => {
  for (const m of ['CW', 'FM', 'AM', 'DIGU', 'PKTUSB', 'FT8', '', null]) {
    assert.strictEqual(V.voiceToData(m, 14074000), null, String(m));
  }
});
test('every codec name for USB-D/LSB-D reads back as voice', () => {
  for (const m of ['DIGU', 'PKTUSB', 'USB-D', 'DATA-U']) assert.strictEqual(V.dataToVoice(m), 'USB');
  for (const m of ['DIGL', 'PKTLSB', 'LSB-D', 'DATA-L']) assert.strictEqual(V.dataToVoice(m), 'LSB');
  for (const m of ['USB', 'CW', 'FM', 'PKTFM']) assert.strictEqual(V.dataToVoice(m), null);
});

console.log('voice-data-mode: RigController');
function makeRig() {
  const codec = new EventEmitter();
  codec.sent = [];
  codec.setMode = (m) => codec.sent.push(m);
  codec.setFrequency = () => {};
  codec.resolveMode = (m) => m;
  const transport = new EventEmitter();
  transport.write = () => {};
  const rig = new RigController({ brand: 'Xiegu', tune: {} }, transport, codec);
  rig.connected = true;
  rig._startPolling = () => {};
  rig._stopPolling = () => {};
  const seen = [];
  rig.on('mode', (m) => seen.push(m));
  return { rig, codec, seen };
}
function flush(rig) { for (const t of rig._pendingTimers) clearTimeout(t); rig._pendingTimers = []; }

test('off: USB goes out as USB and DIGU reads as DIGU', () => {
  const { rig, codec, seen } = makeRig();
  rig.tune(14250000, 'USB'); flush(rig);
  codec.emit('mode', 'DIGU');
  assert.deepStrictEqual(codec.sent, ['USB']);
  assert.deepStrictEqual(seen, ['DIGU']);
});
test('on: a voice tune goes out as DATA and the report reads as voice', () => {
  const { rig, codec, seen } = makeRig();
  rig.setVoiceAsData(true);
  rig.tune(7200000, 'SSB'); flush(rig);
  assert.deepStrictEqual(codec.sent, ['DIGL']);
  codec.emit('mode', 'PKTLSB');
  assert.deepStrictEqual(seen, ['LSB']);
  assert.deepStrictEqual(rig._requestedMd, { mode: 'DIGL', freqHz: 7200000 }); // a reconnect re-sends DATA
});
test('on: setModeOnly maps too (the mode buttons, presets)', () => {
  const { rig, codec } = makeRig();
  rig.setVoiceAsData(true);
  rig.setModeOnly('USB', 14250000); flush(rig);
  assert.deepStrictEqual(codec.sent, ['DIGU']);
});
test('on: JTCAT asking for DIGU is reported as DIGU', () => {
  const { rig, codec, seen } = makeRig();
  rig.setVoiceAsData(true);
  rig.tune(14250000, 'USB'); flush(rig);
  rig.tune(14074000, 'DIGU'); flush(rig);
  codec.emit('mode', 'DIGU');
  assert.deepStrictEqual(codec.sent, ['DIGU', 'DIGU']);
  assert.deepStrictEqual(seen, ['DIGU']);
});
test('on: the radio reporting CW ends the mapping', () => {
  const { rig, codec, seen } = makeRig();
  rig.setVoiceAsData(true);
  rig.tune(14250000, 'USB'); flush(rig);
  codec.emit('mode', 'CW');
  codec.emit('mode', 'DIGU');
  assert.deepStrictEqual(seen, ['CW', 'DIGU']);
});
test('on: CI-V reports plain USB in DATA; the mapping holds', () => {
  const { rig, codec, seen } = makeRig();
  rig.setVoiceAsData(true);
  rig.tune(14250000, 'USB'); flush(rig);
  codec.emit('mode', 'USB');
  codec.emit('mode', 'DIGU');
  assert.deepStrictEqual(seen, ['USB', 'USB']);
});
test('turning it off stops the read-back translation', () => {
  const { rig, codec, seen } = makeRig();
  rig.setVoiceAsData(true);
  rig.tune(14250000, 'USB'); flush(rig);
  rig.setVoiceAsData(false);
  codec.emit('mode', 'DIGU');
  assert.deepStrictEqual(seen, ['DIGU']);
});

console.log('voice-data-mode: wiring');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
test('main applies rig.voiceAsData on connect', () => {
  assert.ok(/cat\.setVoiceAsData\(!!\(vRig && vRig\.voiceAsData\)\)/.test(main));
});
test('SSB-over-DATA stands down on a Voice in DATA rig', () => {
  assert.ok(/!yaesuVoice && !voiceInData && audioActive/.test(main));
});
test('rig editor has the box and saves rig.voiceAsData', () => {
  assert.ok(html.includes('id="set-voice-as-data"'));
  assert.ok(app.includes('rig.voiceAsData = true'));
  assert.ok(app.includes('voiceAsData: true'));
});
test('the G90 setup note points at the option', () => {
  const notes = require('../lib/rig-setup-notes');
  const list = notes.NOTES;
  const n = (Array.isArray(list) ? list : []).find((x) => x.id === 'g90-voice-data-port');
  assert.ok(n, 'note present');
  assert.ok(n.steps.join(' ').includes('Voice in DATA mode (USB-D / LSB-D)'));
});

console.log(`\nvoice-data-mode: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
