#!/usr/bin/env node
'use strict';
// GitHub #916: clicking a spot moved a Xiegu G90's frequency but not its mode
// (14.235 USB -> 14.035 CW left the radio in USB). The G90 runs through
// rigctld (Hamlib 3088). Hamlib's G90 backend marks the mode VFO-targetable,
// so it sets the mode only with CI-V 26; when the radio rejects 26 (G90
// firmware, Hamlib issue 1547) Hamlib sends just the DATA flag (1A 06) and
// never the mode. Reproduced against the bundled rigctld 4.7.2 with a
// simulated G90 that rejects 26: "M CW 0" changed nothing on the radio.
// The G90 now also gets a plain CI-V 06 set-mode frame through `w` before
// each M (standard CI-V, manual v1.01 PDF page 19), at Hamlib's G90 address
// 0xA4. These are the exact bytes a spot click sends.
// Run: node test/g90-mode-on-spot-test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS, GENERIC_CAPS } = require('../lib/rig-models');

let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// The rigctld connection as main.js builds it: the picked model, with the
// rigctld M,F,M,F tune sandwich.
const RIGCTLD_TUNE = { modeBeforeFreq: true, modeAfterFreq: true, freqAfterMode: true, alwaysResendMode: false, daCommand: false };
function rig(baseModel, lastMode) {
  const model = { ...baseModel, tune: baseModel.tune || RIGCTLD_TUNE };
  const writes = [];
  const transport = new EventEmitter();
  transport.write = (d) => writes.push(d);
  transport.connect = () => {};
  transport.disconnect = () => {};
  const codec = new RigctldCodec(model, (d) => writes.push(d));
  const r = new RigController(model, transport, codec);
  r.connected = true;
  if (lastMode) codec.emit('mode', lastMode); // what the radio last reported
  return { r, codec, writes };
}
async function spotClick(baseModel, lastMode, hz, mode) {
  const { r, writes } = rig(baseModel, lastMode);
  r.tune(hz, mode, {});
  await sleep(700);
  return writes;
}

// `w` argument -> the bytes rigctld writes to the serial port.
function rawBytes(line) {
  const m = /^w ((?:\\0x[0-9a-f]{2})+)\n$/i.exec(line);
  assert.ok(m, `not a binary w line: ${JSON.stringify(line)}`);
  return m[1].split('\\0x').filter(Boolean).map((h) => parseInt(h, 16));
}
const civ = (modeByte) => [0xFE, 0xFE, 0xA4, 0xE0, 0x06, modeByte, 0xFD];

(async () => {
  console.log('G90 mode on a spot click (#916)');
  const G90 = RIG_MODELS.G90;

  await test('USB -> CW spot: CI-V 06 03 before each M CW, then the frequency', async () => {
    const w = await spotClick(G90, 'USB', 14035000, 'CW');
    assert.strictEqual(w.length, 6, JSON.stringify(w));
    assert.deepStrictEqual(rawBytes(w[0]), civ(0x03));
    assert.strictEqual(w[1], 'M CW 0\n');
    assert.strictEqual(w[2], 'F 14035000\n');
    assert.deepStrictEqual(rawBytes(w[3]), civ(0x03));
    assert.strictEqual(w[4], 'M CW 0\n');
    assert.strictEqual(w[5], 'F 14035000\n');
  });

  await test('CW -> USB spot: CI-V 06 01', async () => {
    const w = await spotClick(G90, 'CW', 14235000, 'USB');
    assert.deepStrictEqual(rawBytes(w[0]), civ(0x01));
    assert.strictEqual(w[1], 'M USB 0\n');
    assert.strictEqual(w[2], 'F 14235000\n');
  });

  await test('USB -> LSB spot: CI-V 06 00', async () => {
    const w = await spotClick(G90, 'USB', 7200000, 'LSB');
    assert.deepStrictEqual(rawBytes(w[0]), civ(0x00));
    assert.strictEqual(w[1], 'M LSB 0\n');
  });

  await test('an SSB spot on 40 m resolves to LSB: CI-V 06 00', async () => {
    const w = await spotClick(G90, 'CW', 7185000, 'SSB');
    assert.deepStrictEqual(rawBytes(w[0]), civ(0x00));
    assert.strictEqual(w[1], 'M LSB 0\n');
  });

  await test('FT8 spot: base USB with CI-V 06 01, then Hamlib M PKTUSB sets the DATA flag', async () => {
    const w = await spotClick(G90, 'CW', 14074000, 'FT8');
    assert.deepStrictEqual(rawBytes(w[0]), civ(0x01));
    assert.strictEqual(w[1], 'M PKTUSB 0\n');
    assert.strictEqual(w[2], 'F 14074000\n');
  });

  await test('the raw frame comes first in every mode set, so Hamlib\'s DATA flag is the last word', async () => {
    const { codec, writes } = rig(G90, 'USB');
    codec.setMode('DIGL', 7074000);
    assert.deepStrictEqual(rawBytes(writes[0]), civ(0x00));
    assert.strictEqual(writes[1], 'M PKTLSB 0\n');
  });

  await test('another rigctld radio sends no raw frame (generic Hamlib model)', async () => {
    const w = await spotClick(GENERIC_CAPS.rigctld, 'USB', 14035000, 'CW');
    assert.deepStrictEqual(w, ['M CW -1\n', 'F 14035000\n', 'M CW -1\n', 'F 14035000\n']);
  });

  await test('another Hamlib model in the catalog sends no raw frame', async () => {
    const others = Object.entries(RIG_MODELS).filter(([n, m]) => n !== 'G90' && m && m.civModeAddr != null);
    assert.deepStrictEqual(others.map(([n]) => n), []);
  });

  await test('rigctld printing the CI-V echo of a `w` is swallowed, not read as a mode or frequency', async () => {
    const { codec } = rig(G90, null);
    const seen = [];
    codec.on('mode', (m) => seen.push('mode ' + m));
    codec.on('frequency', (f) => seen.push('freq ' + f));
    codec.setMode('CW', 14035000);
    codec.onData('\\0xFE\\0xFE\\0xA4\\0xE0\\0x06\\0x03\\0xFD 7\n');
    assert.deepStrictEqual(seen, []);
    assert.ok(!codec._pending.some((e) => e.kind === 'raw'), 'the raw entry is answered');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
