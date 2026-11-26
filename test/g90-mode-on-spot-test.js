#!/usr/bin/env node
'use strict';
// GitHub #916: clicking a spot moved a Xiegu G90's frequency but not its mode
// (14.235 USB -> 14.035 CW left the radio in USB). The G90 runs through
// rigctld (Hamlib 3088). PR #920 added a raw CI-V 06 set-mode frame through
// `w` before each M, tested only against a simulated G90 that rejects CI-V 26.
// A real G90 (firmware 1.81, bundled Hamlib 4.7.2) rejects that 06 frame (NG)
// and accepts Hamlib's own M (CI-V 26, ACK; FT8 = 26 with the DATA flag), and
// rigctld's `w` leaves the NG in its buffer and closes the link, which looped
// with the reconnect's mode re-send (1.14.8). The G90 now sets its mode with
// Hamlib's M only. The generic guard from #1086 stays: a raw CI-V mode frame
// (any model with civModeAddr; none in the catalog today) that the link drops
// on is not sent again this session.
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
const noRaw = (w) => assert.ok(w.every((l) => !/^w /.test(l)), 'a raw w line was sent: ' + JSON.stringify(w));

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

  await test('USB -> CW spot: M CW, then the frequency, M CW again, no raw frame', async () => {
    const w = await spotClick(G90, 'USB', 14035000, 'CW');
    assert.deepStrictEqual(w, ['M CW 0\n', 'F 14035000\n', 'M CW 0\n', 'F 14035000\n']);
  });

  await test('CW -> USB spot: M USB, no raw frame', async () => {
    const w = await spotClick(G90, 'CW', 14235000, 'USB');
    noRaw(w);
    assert.strictEqual(w[0], 'M USB 0\n');
    assert.strictEqual(w[1], 'F 14235000\n');
  });

  await test('USB -> LSB spot: M LSB, no raw frame', async () => {
    const w = await spotClick(G90, 'USB', 7200000, 'LSB');
    noRaw(w);
    assert.strictEqual(w[0], 'M LSB 0\n');
  });

  await test('an SSB spot on 40 m resolves to M LSB, no raw frame', async () => {
    const w = await spotClick(G90, 'CW', 7185000, 'SSB');
    noRaw(w);
    assert.strictEqual(w[0], 'M LSB 0\n');
  });

  await test('FT8 spot: M PKTUSB (USB plus DATA in one CI-V 26), no raw frame', async () => {
    const w = await spotClick(G90, 'CW', 14074000, 'FT8');
    noRaw(w);
    assert.strictEqual(w[0], 'M PKTUSB 0\n');
    assert.strictEqual(w[1], 'F 14074000\n');
  });

  await test('a direct setMode on the G90 is Hamlib M alone', async () => {
    const { codec, writes } = rig(G90, 'USB');
    codec.setMode('DIGL', 7074000);
    assert.deepStrictEqual(writes, ['M PKTLSB 0\n']);
  });

  await test('the G90 model carries no raw CI-V mode address', async () => {
    assert.strictEqual(G90.civModeAddr, undefined);
  });

  await test('the reconnect mode re-send on a G90 sends nothing raw', async () => {
    const { r, writes } = rig(G90, 'USB');
    r.tune(14035000, 'CW', {});
    await sleep(2300); // the drop comes later than the #1086 guard's 1.5 s window
    r._transport.emit('close');
    writes.length = 0;
    r.connected = true;
    r._enforceRequestedMode(); // what the reconnect runs, 1.5 s later
    await sleep(1700);
    assert.ok(writes.includes('M CW 0\n'), JSON.stringify(writes));
    noRaw(writes);
  });

  await test('another rigctld radio is unchanged (generic Hamlib model)', async () => {
    const w = await spotClick(GENERIC_CAPS.rigctld, 'USB', 14035000, 'CW');
    assert.deepStrictEqual(w, ['M CW -1\n', 'F 14035000\n', 'M CW -1\n', 'F 14035000\n']);
  });

  await test('no model in the catalog sends a raw CI-V mode frame', async () => {
    const withFrame = Object.entries(RIG_MODELS).filter(([, m]) => m && m.civModeAddr != null);
    assert.deepStrictEqual(withFrame.map(([n]) => n), []);
  });

  // The #1086 guard stays generic: a model given civModeAddr (none today) gets
  // the frame, and a link that drops right after it turns it off.
  const FRAMED = { ...G90, civModeAddr: 0xA4 };

  await test('guard: a model with civModeAddr sends the 06 frame before M', async () => {
    const { codec, writes } = rig(FRAMED, 'USB');
    codec.setMode('CW', 14035000);
    assert.deepStrictEqual(rawBytes(writes[0]), civ(0x03));
    assert.strictEqual(writes[1], 'M CW 0\n');
  });

  await test('guard: rigctld printing the CI-V echo of a `w` is swallowed, not read as a mode or frequency', async () => {
    const { codec } = rig(FRAMED, null);
    const seen = [];
    codec.on('mode', (m) => seen.push('mode ' + m));
    codec.on('frequency', (f) => seen.push('freq ' + f));
    codec.setMode('CW', 14035000);
    codec.onData('\\0xFE\\0xFE\\0xA4\\0xE0\\0x06\\0x03\\0xFD 7\n');
    assert.deepStrictEqual(seen, []);
    assert.ok(!codec._pending.some((e) => e.kind === 'raw'), 'the raw entry is answered');
  });

  await test('guard: a link that drops right after the raw frame turns it off: the next mode set is M alone', async () => {
    const { r, codec, writes } = rig(FRAMED, 'USB');
    codec.setMode('CW', 14035000);
    assert.deepStrictEqual(rawBytes(writes[0]), civ(0x03));
    r._transport.emit('close');
    writes.length = 0;
    codec.setMode('USB', 14235000);
    assert.deepStrictEqual(writes, ['M USB 0\n']);
  });

  await test('guard: after that drop the reconnect mode re-send carries no raw frame (no connect-drop loop)', async () => {
    const { r, writes } = rig(FRAMED, 'USB');
    r.tune(14035000, 'CW', {});
    await sleep(700);
    r._transport.emit('close');
    writes.length = 0;
    r.connected = true;
    r._enforceRequestedMode();
    await sleep(1700);
    assert.ok(writes.includes('M CW 0\n'), JSON.stringify(writes));
    noRaw(writes);
  });

  await test('guard: a link that drops long after the raw frame keeps it', async () => {
    const { r, codec, writes } = rig(FRAMED, 'USB');
    codec.setMode('CW', 14035000);
    codec._civModeSentMs = Date.now() - 60000;
    r._transport.emit('close');
    writes.length = 0;
    codec.setMode('USB', 14235000);
    assert.deepStrictEqual(rawBytes(writes[0]), civ(0x01));
    assert.strictEqual(writes[1], 'M USB 0\n');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
