#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Transmit-safety review, low items:
//  8. The CI-V drop detector kept counting while a hand-mic over skipped the
//     mode polls: the window now stands still while transmitting.
//  9. A Winlink frame re-keyed inside the drain hold now restarts the stuck-TX
//     limit, so back-to-back frames are not one long over.
// 10. Full power (W) is applied on the rigctld raw-PC path too: a 5 W radio
//     behind a 100 W Kenwood emulation sends PC100 for 5 W.
// 12. A multi-slice key-down names its own slice's mode to the TX limit.
// Run: node test/tx-review-low-test.js
const assert = require('assert');
const path = require('path');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { applyFullPower } = require('../lib/rig-full-power');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js'));

test('8: the drop detector\'s window stands still while transmitting', () => {
  const codec = new CivCodec({ brand: 'Icom', civAddr: 0x94, caps: {}, cw: {} }, () => {}, { pace: 'auto' });
  codec.pacingCheck(0);
  codec.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x03, 0x00, 0x40, 0x07, 0x14, 0x00, 0xFD]));   // it answers
  for (let t = 1000; t <= 30000; t += 1000) assert.strictEqual(codec.pacingCheck(t, { paused: true }), false, 'a 30 s over proves nothing');
  assert.strictEqual(codec.pacingCheck(39000), false, 'nine seconds of receive after it: not yet');
  assert.strictEqual(codec.pacingCheck(41000), true, 'ten seconds of receive with no mode: paced');
  codec._pacer.reset();
});

test('9: a Winlink frame re-keyed inside the drain hold restarts the stuck-TX limit', () => {
  const at = main.indexOf('// Keyed again inside the drain hold: stay keyed, nothing to re-assert.');
  const block = main.slice(at, at + 700);
  assert.ok(/clearTimeout\(_winlinkUnkeyTimer\); _winlinkUnkeyTimer = null;\s*try \{ txLimit\(\)\.disarm\(\); txLimit\(\)\.arm\('winlink'\); \}/.test(block));
});

test('10: Full power (W) on the rigctld raw-PC path: 5 W is PC100, PC100 reads back as 5 W', () => {
  const ts2000 = { brand: 'Kenwood', protocol: 'rigctld', maxPower: 100, caps: { txpower: true }, cw: {} };
  const model = applyFullPower(ts2000, { fullPowerW: 5 });
  const writes = [];
  const c = new RigctldCodec(model, (d) => writes.push(String(d)));
  const powers = [];
  c.on('power', (w) => powers.push(w));
  c.setTxPowerWatts(5);
  assert.ok(writes.some((w) => w === 'w PC100;\n'), writes.join('|'));
  writes.length = 0;
  c.setTxPowerWatts(2.5);
  assert.ok(writes.some((w) => w === 'w PC050;\n'), writes.join('|'));
  c._parseLine('PC100;');
  assert.deepStrictEqual(powers, [5]);
  const plain = new RigctldCodec(ts2000, (d) => writes.push(String(d)));
  writes.length = 0;
  plain.setTxPowerWatts(25);
  assert.ok(writes.some((w) => w === 'w PC025;\n'), 'no override: watts as before');
});

test('12: a multi-slice key-down names its own slice\'s mode', () => {
  assert.ok(/function jtcatTxKind\(engine\) \{\s*const eng = engine \|\| ft8Engine;/.test(main));
  assert.ok(/txKind: jtcatTxKind\(engine\) \}\);/.test(main));
});

console.log(`\nTransmit-safety low items: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
